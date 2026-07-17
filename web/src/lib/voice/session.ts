// Voice session — wires the RealtimeSession over the local transport, the browser mic/playback, and the
// chat thread. RealtimeSession owns history/tools/guardrails; LocalRealtimeTransport drives turns
// through the same provider-aware SDK model as the text agent, and the mic/VAD (audio.ts) feeds it.
//
// Lifecycle: startVoice() -> getUserMedia + connect + capture; stopVoice() tears it down. Barge-in is
// automatic: a fresh utterance interrupts the in-flight turn (transport.interrupt -> audio.stopPlayback).
import { RealtimeAgent, RealtimeSession } from "@openai/agents-realtime";
import { S, pushThread, patchThread, logEvent, setVoice } from "../../store";
import { webSearchTool } from "../tools/search";
import { installModelProvider } from "../runtime/model/model";
import { loadVoiceConfig } from "./config";
import { LocalRealtimeTransport } from "./transport";
import { VoiceAudio } from "./audio";
import { createWorkerStt } from "./worker-stt";
import { Tts } from "./tts";
import { pcm16ToArrayBuffer } from "./pcm";

/* eslint-disable @typescript-eslint/no-explicit-any */

const VOICE_INSTRUCTIONS = `You are AUTOMO in voice mode — spoken conversation with the user. Keep replies short, natural, and directly spoken (no markdown, lists, or code blocks). Use web_search for anything time-sensitive. Be warm and concise.`;

let audio: VoiceAudio | null = null;
let session: RealtimeSession | null = null;
let assistantThreadId: string | null = null;

export function voiceActive(): boolean { return !!session; }

export async function startVoice(): Promise<void> {
  if (session) return;
  if (!S.model) { logEvent("error", "voice: pick a chat model first"); return; }
  setVoice({ active: true, state: "loading" });
  try {
    installModelProvider(S.model); // ensure the shared model provider is live for the transport
    const cfg = loadVoiceConfig();
    const stt = await createWorkerStt(cfg.asrModelId, "q8");
    const tts = new Tts(cfg.ttsModelId, cfg.ttsDtype, cfg.ttsVoice);
    await tts.load();

    const transport = new LocalRealtimeTransport({ cfg, tts, stt });
    const agent = new RealtimeAgent({ name: "AUTOMO", instructions: VOICE_INSTRUCTIONS, voice: cfg.ttsVoice, tools: [webSearchTool] });
    session = new RealtimeSession(agent as any, { transport: transport as any });

    session.on("audio", (e: any) => { setVoice({ active: true, state: "speaking" }); audio?.enqueue(e.data); });
    session.on("audio_interrupted", () => audio?.stopPlayback());
    session.on("history_added", (item: any) => bridgeItem(item));
    (session as any).on?.("error", (e: any) => logEvent("error", "voice: " + (e?.error?.message ?? String(e?.error ?? e))));

    await session.connect({ apiKey: "local" }); // apiKey is required by the type; the transport ignores it

    audio = new VoiceAudio(cfg);
    await audio.startCapture((pcm16k) => {
      session?.interrupt(); // barge-in: a new utterance cancels the current turn
      setVoice({ active: true, state: "thinking" });
      session?.transport.sendAudio(pcm16ToArrayBuffer(pcm16k), { commit: true });
    });
    setVoice({ active: true, state: "listening" });
    logEvent("info", "voice session started");
  } catch (err: any) {
    logEvent("error", "voice failed to start: " + (err?.message ?? String(err)));
    await stopVoice();
    throw err;
  }
}

export async function stopVoice(): Promise<void> {
  try { audio?.stopCapture(); audio?.stopPlayback(); } catch { /* noop */ }
  try { (session as any)?.close?.(); } catch { /* noop */ }
  audio = null; session = null; assistantThreadId = null;
  setVoice({ active: false, state: "idle" });
}

// Render voice turns into the shared chat thread so speaking and typing land in one transcript.
function bridgeItem(item: any): void {
  if (item?.type !== "message") return;
  const text = (item.content ?? []).map((c: any) => c.text ?? c.transcript ?? "").join(" ").trim();
  if (!text) return;
  if (item.role === "user") {
    assistantThreadId = null;
    pushThread({ kind: "msg", role: "user", text });
  } else if (item.role === "assistant") {
    if (assistantThreadId) patchThread(assistantThreadId, { text });
    else assistantThreadId = pushThread({ kind: "msg", role: "assistant", text });
  }
}
