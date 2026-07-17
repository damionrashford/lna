// BrowserModel — an SDK `Model` backed by the in-browser transformers.js engine (@automo/inference's
// createBrowserEngine). The SandboxAgent resolves its model through the default model provider, so
// returning a BrowserModel routes every turn through WebGPU/WASM generation on the user's machine.
//
// Constraint: transformers.js generates text only — no native tool-call transport. Agent tools (shell,
// apply_patch, MCP) are surfaced as prompt text; whether they fire depends on the model emitting tool
// syntax the SDK can parse.
import type { Model, ModelRequest, ModelResponse, StreamEvent, AgentOutputItem } from "@openai/agents";
import { Usage } from "@openai/agents";
import { createBrowserEngine, createWebllmEngine, createWorkerEngine, type BrowserEngine } from "@automo/inference";
import { logEvent } from "../../../store";

export type BrowserEngineKind = "transformers" | "webllm";

/* eslint-disable @typescript-eslint/no-explicit-any */

// Extract plain text from any AgentInputItem shape (string, {content:string}, or {content:[{text}]}).
function itemText(item: any): string {
  if (typeof item === "string") return item;
  const c = item?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p: any) => p?.text ?? p?.refusal ?? "").join("");
  return "";
}
const roleOf = (item: any): string => (["user", "assistant", "system"].includes(item?.role) ? item.role : "user");

// ModelRequest.input (string | AgentInputItem[]) + systemInstructions → chat messages for the engine.
function messagesFrom(request: ModelRequest): { role: string; content: string }[] {
  const msgs: { role: string; content: string }[] = [];
  if (request.systemInstructions) msgs.push({ role: "system", content: request.systemInstructions });
  const input = request.input;
  if (typeof input === "string") msgs.push({ role: "user", content: input });
  else for (const item of input) { const content = itemText(item); if (content) msgs.push({ role: roleOf(item), content }); }
  return msgs;
}

const estTokens = (s: string) => Math.ceil(s.length / 4); // rough — transformers.js doesn't report usage
const assistantMsg = (text: string): AgentOutputItem =>
  ({ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text }] }) as any;

export class BrowserModel implements Model {
  private engine: Promise<BrowserEngine> | null = null;
  private workerActive = false; // the current engine runs in the inference worker
  // engineKind selects the in-browser runtime: "webllm" (MLC) or "transformers" (ONNX).
  constructor(private modelName: string, private engineKind: BrowserEngineKind = "transformers", private dtype = "q4f16") {}

  private mainThreadEngine(): Promise<BrowserEngine> {
    return this.engineKind === "webllm" ? createWebllmEngine(this.modelName) : createBrowserEngine(this.modelName, this.dtype);
  }

  private getEngine(): Promise<BrowserEngine> {
    if (!this.engine) {
      logEvent("info", `loading in-browser model ${this.modelName} via ${this.engineKind} — first run fetches weights`);
      this.engine = (async () => {
        // transformers.js runs in the dedicated inference worker (its ONNX/WASM generation is the main
        // source of main-thread jank). web-llm keeps its own library-managed worker and runs directly.
        if (this.engineKind === "transformers") {
          try {
            const e = await createWorkerEngine(this.modelName, this.engineKind, this.dtype);
            this.workerActive = true;
            return e;
          } catch (e: any) {
            logEvent("warn", "inference worker unavailable; running on the main thread: " + (e?.message ?? e));
          }
        }
        this.workerActive = false;
        return this.mainThreadEngine();
      })().catch((e) => { this.engine = null; throw e; });
    }
    return this.engine;
  }

  // Drop the worker engine so the next getEngine() rebuilds on the main thread.
  private demoteToMainThread(reason: string) {
    logEvent("warn", "inference worker failed; falling back to the main thread: " + reason);
    this.engine = null;
    this.workerActive = false;
  }

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const msgs = messagesFrom(request);
    let text: string;
    try {
      text = await (await this.getEngine()).chat(msgs, { maxNewTokens: 1024 });
    } catch (e: any) {
      if (!this.workerActive) throw e;
      this.demoteToMainThread(e?.message ?? String(e));
      text = await (await this.getEngine()).chat(msgs, { maxNewTokens: 1024 });
    }
    const inputTokens = estTokens(msgs.map((m) => m.content).join("\n"));
    const outputTokens = estTokens(text);
    return { usage: new Usage({ requests: 1, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }), output: [assistantMsg(text)] };
  }

  // One generation attempt: bridge the engine's token callback into a queue the loop drains as
  // output_text_delta. Returns the full text; on failure, throws an error tagged with whether any token
  // was emitted (so the caller knows if a clean restart is possible).
  private async *streamOnce(engine: BrowserEngine, msgs: { role: string; content: string }[]): AsyncGenerator<StreamEvent, string> {
    const queue: string[] = [];
    let done = false, full = "", err: any = null, wake: (() => void) | null = null;
    const ping = () => { wake?.(); wake = null; };
    const chat = engine.chat(msgs, { maxNewTokens: 1024, onToken: (t) => { queue.push(t); ping(); } })
      .then((f) => { full = f; })
      .catch((e) => { err = e; })
      .finally(() => { done = true; ping(); });

    let emitted = "";
    for (;;) {
      while (queue.length) { const d = queue.shift()!; emitted += d; yield { type: "output_text_delta", delta: d } as StreamEvent; }
      if (done) break;
      await new Promise<void>((r) => { wake = r; });
    }
    await chat;
    if (err) throw Object.assign(err instanceof Error ? err : new Error(String(err)), { emittedAny: emitted.length > 0 });
    return full || emitted;
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    const msgs = messagesFrom(request);
    yield { type: "response_started" } as StreamEvent;

    let text: string;
    try {
      text = yield* this.streamOnce(await this.getEngine(), msgs);
    } catch (e: any) {
      // A clean restart is only possible if the worker failed before emitting any token.
      if (!this.workerActive || e?.emittedAny) throw e;
      this.demoteToMainThread(e?.message ?? String(e));
      text = yield* this.streamOnce(await this.getEngine(), msgs);
    }

    const inputTokens = estTokens(msgs.map((m) => m.content).join("\n"));
    const outputTokens = estTokens(text);
    yield {
      type: "response_done",
      response: { id: crypto.randomUUID(), usage: { requests: 1, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }, output: [assistantMsg(text)] },
    } as StreamEvent;
  }
}
