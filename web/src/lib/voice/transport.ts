// LocalRealtimeTransport — a fully-local `RealtimeTransportLayer` for @openai/agents-realtime, ported
// from voice-box/src/transport/localTransport.ts. The event synthesis is framework-agnostic; the ONE
// substantive change from the source is the brain: instead of a hand-rolled Ollama `streamTurn`, each
// turn runs through resolveBrainModel() — the SAME provider-aware SDK Model the text agent uses (Ollama
// shim / vLLM native / in-browser). STT/TTS are swapped for the browser ONNX engines (asr.ts / tts.ts).
//
// Per-turn emission contract (verified against agents-realtime, unchanged in 0.13.4):
//   item_update(user) → turn_started → transcript_delta.. → audio.. → item_update(assistant)
//   → audio_done → turn_done   (tool turns insert function_call and DEFER turn_done)
import { EventEmitterDelegate } from "@openai/agents-core/utils";
import { RuntimeEventEmitter } from "@openai/agents-core";
import type {
  RealtimeTransportLayer, RealtimeTransportLayerConnectOptions, RealtimeTransportEventTypes,
  TransportToolCallEvent, RealtimeSessionConfig, RealtimeItem, RealtimeClientMessage,
} from "@openai/agents-realtime";
import type { AgentInputItem, SerializedTool } from "@openai/agents";
import { resolveBrainModel } from "../runtime/model";
import type { VoiceConfig } from "./config";
import type { Tts, TtsSession } from "./tts";
import type { Stt } from "./asr";
import { concatPcm, pcm16ToArrayBuffer } from "./pcm";

/* eslint-disable @typescript-eslint/no-explicit-any */
const uuid = () => crypto.randomUUID();

function toSerializedTools(tools: any[] | undefined): SerializedTool[] {
  return (tools ?? []).filter((t) => t?.type === "function" && t?.name).map((t) => ({
    type: "function", name: t.name, description: t.description ?? "",
    parameters: t.parameters ?? { type: "object", properties: {} }, strict: false,
  })) as SerializedTool[];
}
function extractText(message: any): string {
  if (typeof message === "string") return message;
  const content = message?.content;
  if (Array.isArray(content)) return content.filter((c: any) => c?.type === "input_text" || c?.type === "text").map((c: any) => c.text ?? "").join(" ").trim();
  return "";
}

export class LocalRealtimeTransport extends EventEmitterDelegate<RealtimeTransportEventTypes> implements RealtimeTransportLayer {
  // cast: the node-shim RuntimeEventEmitter's key signature (string|symbol|number) is stricter than the
  // delegate's abstract EventEmitter<EventTypes>; behaviourally identical, so satisfy the type by cast.
  protected eventEmitter = new RuntimeEventEmitter<RealtimeTransportEventTypes>() as any;
  status: "connected" | "disconnected" | "connecting" | "disconnecting" = "disconnected";

  #cfg: VoiceConfig; #tts: Tts; #stt: Stt;
  #history: AgentInputItem[] = [];
  #instructions = ""; #tools: SerializedTool[] = [];
  #voice: string; #speed: number;
  #audioBuf: Int16Array[] = [];
  #activeTurn: { cancelled: boolean } | null = null;
  #abort: AbortController | null = null;
  #currentTts: TtsSession | null = null;
  #pending: { count: number; startResponse: boolean } | null = null;

  constructor(deps: { cfg: VoiceConfig; tts: Tts; stt: Stt }) {
    super();
    this.#cfg = deps.cfg; this.#tts = deps.tts; this.#stt = deps.stt;
    this.#voice = deps.cfg.ttsVoice; this.#speed = deps.cfg.ttsSpeed;
  }
  get muted(): boolean | null { return null; } // handled in the mic layer

  #setStatus(s: "connecting" | "connected" | "disconnected") { this.status = s; this.emit("connection_change", s); }

  async connect(options: RealtimeTransportLayerConnectOptions): Promise<void> {
    this.#setStatus("connecting");
    this.#applyConfig((options.initialSessionConfig ?? {}) as any, true);
    this.#setStatus("connected");
  }
  updateSessionConfig(config: Partial<RealtimeSessionConfig>): void { this.#applyConfig(config as any, false); }

  #applyConfig(cfg: any, _isInitial: boolean): void {
    if (cfg.instructions != null) this.#instructions = cfg.instructions;
    if (cfg.tools) this.#tools = toSerializedTools(cfg.tools);
    const out = cfg.audio?.output;
    if (out?.voice) this.#voice = out.voice;
    if (out?.speed != null) this.#speed = out.speed;
    if (cfg.voice) this.#voice = cfg.voice;
  }

  // ---- user input ----
  sendMessage(message: any, _other: Record<string, any>, options?: { triggerResponse?: boolean }): void {
    const text = extractText(message);
    if (!text) return;
    const itemId = uuid();
    this.#history.push({ type: "message", role: "user", content: [{ type: "input_text", text }] } as any);
    this.#emitItem({ itemId, type: "message", role: "user", status: "completed", content: [{ type: "input_text", text }] } as any);
    if (options?.triggerResponse !== false) this.#drive();
  }
  sendAudio(audio: ArrayBuffer, options: { commit?: boolean }): void {
    this.#audioBuf.push(new Int16Array(audio));
    if (options?.commit) { const pcm = concatPcm(this.#audioBuf); this.#audioBuf = []; void this.#handleUtterance(pcm); }
  }
  async #handleUtterance(pcm: Int16Array): Promise<void> {
    let transcript = "";
    try { transcript = await this.#stt.transcribe(pcm); } catch (error) { this.emit("error", { type: "error", error } as any); return; }
    if (!transcript) return;
    const itemId = uuid();
    this.#history.push({ type: "message", role: "user", content: [{ type: "input_text", text: transcript }] } as any);
    this.#emitItem({ itemId, type: "message", role: "user", status: "completed", content: [{ type: "input_audio", transcript, audio: null }] } as any);
    this.emit("*", { type: "conversation.item.input_audio_transcription.completed", item_id: itemId, transcript } as any);
    this.#drive();
  }

  // ---- response generation (shared SDK model) ----
  #drive(): void { void this.#startResponse().catch((error) => { if (this.#activeTurn?.cancelled) return; this.emit("error", { type: "error", error } as any); }); }

  async #startResponse(): Promise<void> {
    const turn = { cancelled: false }; this.#activeTurn = turn;
    const responseId = uuid(), assistantItemId = uuid();
    const ac = new AbortController(); this.#abort = ac;
    this.emit("turn_started", { type: "response_started", providerData: { response: { id: responseId } } } as any);

    const ensureTts = (): TtsSession => {
      if (!this.#currentTts) this.#currentTts = this.#tts.createSession({ voice: this.#voice, speed: this.#speed }, (pcm) => {
        if (!turn.cancelled) this.emit("audio", { type: "audio", data: pcm16ToArrayBuffer(pcm), responseId } as any);
      });
      return this.#currentTts;
    };

    let assistantText = ""; const outputItems: any[] = [];
    try {
      const model = await resolveBrainModel(); // the same provider-aware model the text agent uses
      const stream = model.getStreamedResponse({
        systemInstructions: this.#instructions, input: this.#history, modelSettings: { temperature: this.#cfg.temperature, maxTokens: this.#cfg.maxTokens },
        tools: this.#tools, toolsExplicitlyProvided: true, outputType: "text" as any, handoffs: [], tracing: false, signal: ac.signal,
      });
      for await (const ev of stream as any) {
        if (turn.cancelled) break;
        if (ev.type === "output_text_delta" && ev.delta) {
          assistantText += ev.delta; ensureTts().push(ev.delta);
          this.emit("audio_transcript_delta", { type: "transcript_delta", itemId: assistantItemId, delta: ev.delta, responseId } as any);
        } else if (ev.type === "response_done") {
          outputItems.push(...(ev.response?.output ?? []));
        }
      }
    } catch (error) {
      if (turn.cancelled) return;
      await this.#currentTts?.end().catch(() => {}); this.#currentTts = null; throw error;
    }
    await this.#currentTts?.end().catch(() => {}); this.#currentTts = null;
    if (turn.cancelled) return;

    // ---- tool round-trip: defer turn_done until outputs come back ----
    const calls = outputItems.filter((o) => o?.type === "function_call");
    if (calls.length) {
      for (const c of calls) this.#history.push(c as any); // keep the assistant's tool-call items in history
      this.#pending = { count: calls.length, startResponse: false };
      this.emit("audio_done");
      for (const c of calls) {
        this.#emitToolItem(c.callId, c.name, c.arguments, "in_progress", null);
        this.emit("function_call", { id: uuid(), type: "function_call", name: c.name, callId: c.callId, arguments: c.arguments, responseId } as TransportToolCallEvent);
      }
      this.#activeTurn = null; this.#abort = null; return;
    }

    // ---- final spoken answer ----
    const finalText = (assistantText || outputItems.map((o) => o?.content?.map?.((c: any) => c.text ?? c.transcript ?? "").join("")).join("") || "").trim();
    this.#history.push({ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: finalText }] } as any);
    this.#emitItem({ itemId: assistantItemId, type: "message", role: "assistant", status: "completed", content: [{ type: "output_audio", transcript: finalText, audio: null }] } as any);
    this.emit("audio_done");
    this.emit("turn_done", { type: "response_done", response: { id: responseId, output: [{ id: assistantItemId, type: "message", role: "assistant", status: "completed", content: [{ type: "output_audio", transcript: finalText }] }], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, inputTokensDetails: {}, outputTokensDetails: {} } } } as any);
    this.#activeTurn = null; this.#abort = null;
  }

  sendFunctionCallOutput(toolCall: TransportToolCallEvent, output: string, startResponse: boolean): void {
    this.#history.push({ type: "function_call_result", name: toolCall.name, callId: toolCall.callId, status: "completed", output: { type: "text", text: output } } as any);
    this.#emitToolItem(toolCall.callId, toolCall.name, toolCall.arguments, "completed", output);
    if (!this.#pending) { if (startResponse) this.#drive(); return; }
    this.#pending.count -= 1;
    if (startResponse) this.#pending.startResponse = true;
    if (this.#pending.count <= 0) { const go = this.#pending.startResponse; this.#pending = null; if (go) this.#drive(); }
  }
  requestResponse(): void { this.#drive(); }

  // ---- interruption / lifecycle ----
  interrupt(): void {
    if (this.#activeTurn) this.#activeTurn.cancelled = true;
    this.#abort?.abort(); this.#currentTts?.cancel(); this.#currentTts = null;
    this.emit("audio_interrupted");
  }
  close(): void { this.status = "disconnecting"; this.interrupt(); this.#setStatus("disconnected"); }

  // ---- raw / unused channels (safe per the contract) ----
  sendEvent(event: RealtimeClientMessage): void { if ((event as any)?.type === "response.create") this.#drive(); }
  addImage(): void { /* voice-only local stack */ }
  mute(): void { /* mic muting lives in the audio layer */ }
  resetHistory(_old: RealtimeItem[], newHistory: RealtimeItem[]): void {
    const rebuilt: AgentInputItem[] = [];
    for (const item of newHistory as any[]) {
      if (item?.type !== "message") continue;
      const text = (item.content ?? []).map((c: any) => c.text ?? c.transcript ?? "").join(" ").trim();
      if (!text) continue;
      rebuilt.push({ type: "message", role: item.role, content: [{ type: item.role === "user" ? "input_text" : "output_text", text }] } as any);
    }
    this.#history = rebuilt;
  }
  sendMcpResponse(): void { /* no hosted MCP in the local stack */ }

  // ---- emit helpers ----
  #emitItem(item: any): void { this.emit("item_update", item); }
  #emitToolItem(callId: string, name: string, args: string, status: "in_progress" | "completed", output: string | null): void {
    this.emit("item_update", { itemId: callId, type: "function_call", status, name, arguments: args, output } as any);
  }
}
