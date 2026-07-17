// Off-main-thread host for the transformers.js inference engine. Running its ONNX/WASM generation in a
// dedicated worker keeps the main thread free, so the UI stays responsive during a model turn. WebGPU and
// WASM are available in workers, so the engine runs here unchanged. One engine is cached and reloaded only
// when the model changes. Bundled by scripts/build.ts — the node-shim and transformers web-build plugins
// apply to this worker too. (web-llm keeps its own library-managed worker and runs on the main thread.)
import { createBrowserEngine, type BrowserEngine } from "./transformers";

/* eslint-disable @typescript-eslint/no-explicit-any */
let engine: BrowserEngine | null = null;
let loaded = "";

async function engineFor(model: string, dtype: string): Promise<BrowserEngine> {
  if (engine && loaded === model) return engine;
  if (engine) { try { await engine.unload(); } catch { /* best-effort */ } engine = null; }
  loaded = model;
  engine = await createBrowserEngine(model, dtype);
  return engine;
}

self.addEventListener("message", async (e: MessageEvent) => {
  const d: any = e.data;
  const post = (m: any) => (self as any).postMessage(m);
  try {
    if (d.op === "ping") {
      post({ id: d.id, type: "done", text: "" }); // liveness check — the worker script loaded
    } else if (d.op === "chat") {
      const eng = await engineFor(d.model, d.dtype);
      const text = await eng.chat(d.msgs, { maxNewTokens: d.maxNewTokens, onToken: (t) => post({ id: d.id, type: "token", t }) });
      post({ id: d.id, type: "done", text });
    } else if (d.op === "unload") {
      if (engine) { try { await engine.unload(); } catch { /* best-effort */ } engine = null; loaded = ""; }
      post({ id: d.id, type: "done", text: "" });
    }
  } catch (err: any) {
    post({ id: d.id, type: "error", message: err?.message ?? String(err) });
  }
});
