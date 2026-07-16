// BrowserModel — an SDK `Model` backed by the in-browser transformers.js engine (@automo/inference's
// createBrowserEngine). This is what lets the `browser` provider actually DRIVE the agent, not just a
// degraded tools-less chat: the SandboxAgent resolves its model through the default model provider, so
// returning a BrowserModel here routes every turn through WebGPU/WASM generation on the user's machine.
//
// Caveat by design: transformers.js generates TEXT only — no native tool-call transport. The agent's
// tools (shell, apply_patch, MCP) are surfaced to the model as prompt text; whether they fire depends on
// the model emitting tool syntax the SDK can parse. So this is real local inference, capability-degraded.
import type { Model, ModelRequest, ModelResponse, StreamEvent, AgentOutputItem } from "@openai/agents";
import { Usage } from "@openai/agents";
import { createBrowserEngine, type BrowserEngine } from "@automo/inference";
import { logEvent } from "../store";

/* eslint-disable @typescript-eslint/no-explicit-any */

// pull plain text out of any AgentInputItem shape (string, {content:string}, or {content:[{text}]})
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
  constructor(private modelName: string, private dtype = "q4f16") {}

  private getEngine(): Promise<BrowserEngine> {
    if (!this.engine) {
      logEvent("info", `loading in-browser model ${this.modelName} (${this.dtype}) — first run fetches weights`);
      this.engine = createBrowserEngine(this.modelName, this.dtype).catch((e) => { this.engine = null; throw e; });
    }
    return this.engine;
  }

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const engine = await this.getEngine();
    const msgs = messagesFrom(request);
    const text = await engine.chat(msgs, { maxNewTokens: 1024 });
    const inputTokens = estTokens(msgs.map((m) => m.content).join("\n"));
    const outputTokens = estTokens(text);
    return { usage: new Usage({ requests: 1, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }), output: [assistantMsg(text)] };
  }

  // Bridge the engine's token CALLBACK into an async generator: tokens land in a queue, the loop drains
  // it and yields output_text_delta, waking on each token until generation settles, then response_done.
  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    const engine = await this.getEngine();
    const msgs = messagesFrom(request);
    yield { type: "response_started" } as StreamEvent;

    const queue: string[] = [];
    let done = false, full = "", wake: (() => void) | null = null;
    const ping = () => { wake?.(); wake = null; };
    const chat = engine.chat(msgs, { maxNewTokens: 1024, onToken: (t) => { queue.push(t); ping(); } })
      .then((f) => { full = f; })
      .finally(() => { done = true; ping(); });

    let emitted = "";
    for (;;) {
      while (queue.length) { const d = queue.shift()!; emitted += d; yield { type: "output_text_delta", delta: d } as StreamEvent; }
      if (done) break;
      await new Promise<void>((r) => { wake = r; });
    }
    await chat; // surface a generation error to the runner

    const text = full || emitted;
    const inputTokens = estTokens(msgs.map((m) => m.content).join("\n"));
    const outputTokens = estTokens(text);
    yield {
      type: "response_done",
      response: { id: crypto.randomUUID(), usage: { requests: 1, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }, output: [assistantMsg(text)] },
    } as StreamEvent;
  }
}
