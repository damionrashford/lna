// Main-thread proxy for the inference worker. Implements the BrowserEngine interface by RPC to a shared
// worker: token callbacks arrive as messages and replay to the local onToken. One worker serves all
// engines (a single model is active at a time; the worker reloads on model change).
//
// The worker is a separate module built to <base>/inference-worker.js (see scripts/build.ts). `connect()`
// pings it before use; a failed ping (missing build in dev, blocked worker, no WebGPU) rejects so the
// caller runs on the main thread instead.
import type { BrowserEngine } from "./transformers";

/* eslint-disable @typescript-eslint/no-explicit-any */
// import.meta.url resolves to this chunk's URL at the site base, so the sibling worker file lands at
// <base>/inference-worker.js.
const WORKER_URL = new URL("inference-worker.js", import.meta.url);

let worker: Worker | null = null;
function getWorker(): Worker {
  if (!worker) worker = new Worker(WORKER_URL, { type: "module" });
  return worker;
}

let seq = 0;
function call(op: string, payload: any, onToken?: (t: string) => void): Promise<string> {
  const w = getWorker();
  const id = ++seq;
  return new Promise<string>((resolve, reject) => {
    const onMsg = (e: MessageEvent) => {
      const d: any = e.data;
      if (d?.id !== id) return;
      if (d.type === "token") onToken?.(d.t);
      else if (d.type === "done") { w.removeEventListener("message", onMsg); resolve(d.text); }
      else if (d.type === "error") { w.removeEventListener("message", onMsg); reject(new Error(d.message)); }
    };
    w.addEventListener("message", onMsg);
    w.postMessage({ id, op, ...payload });
  });
}

// Verify the worker script loaded and responds; rejects on timeout so the caller can fall back.
async function ping(timeoutMs = 8000): Promise<void> {
  await Promise.race([
    call("ping", {}),
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error("worker ping timeout")), timeoutMs)),
  ]);
}

export async function createWorkerEngine(model: string, kind: "transformers" | "webllm", dtype: string): Promise<BrowserEngine> {
  await ping(); // throws where the worker is unavailable → caller uses the main-thread engine
  return {
    model,
    chat: (msgs, opts) => call("chat", { model, kind, dtype, msgs, maxNewTokens: opts?.maxNewTokens }, opts?.onToken),
    unload: async () => { await call("unload", {}); },
  };
}
