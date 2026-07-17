// Main-thread proxy for the ASR worker. Implements the Stt interface by RPC to dist/voice-worker.js; a
// failed liveness ping falls back to the direct main-thread Whisper (createStt).
import { createStt, type Stt } from "./asr";

/* eslint-disable @typescript-eslint/no-explicit-any */
const WORKER_URL = new URL("voice-worker.js", import.meta.url);
let worker: Worker | null = null;
function getWorker(): Worker {
  if (!worker) worker = new Worker(WORKER_URL, { type: "module" });
  return worker;
}

let seq = 0;
function rpc<T = any>(op: string, payload?: any): Promise<T> {
  const w = getWorker();
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    const onMsg = (e: MessageEvent) => {
      const d: any = e.data;
      if (d?.id !== id) return;
      w.removeEventListener("message", onMsg);
      d.ok ? resolve(d.text) : reject(new Error(d.error));
    };
    w.addEventListener("message", onMsg);
    w.postMessage({ id, op, ...payload });
  });
}

async function ping(timeoutMs = 10000): Promise<void> {
  await Promise.race([rpc("ping"), new Promise<never>((_, r) => setTimeout(() => r(new Error("voice worker ping timeout")), timeoutMs))]);
}

// Whisper STT running in the voice worker; falls back to the main thread when the worker is unavailable.
export async function createWorkerStt(model: string, dtype: string): Promise<Stt> {
  try {
    await ping();
  } catch {
    return createStt(model, dtype);
  }
  return {
    transcribe: (pcm16k) => rpc<string>("transcribe", { model, dtype, pcm: pcm16k }),
    unload: async () => { await rpc("unload").catch(() => {}); },
  };
}
