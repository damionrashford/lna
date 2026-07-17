// Browser STT — Whisper via transformers.js (ONNX Runtime Web, WebGPU with WASM fallback).
// Contract: transcribe(16 kHz mono Int16) -> clean text.
//
// `@huggingface/transformers` is a runtime-resolved dynamic import (variable specifier) so this module
// bundles without the dep; it must be installed to run.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { pcm16ToFloat32 } from "./pcm";

export interface Stt {
  transcribe(pcm16k: Int16Array): Promise<string>;
  unload(): Promise<void>;
}

export async function createStt(modelId = "onnx-community/whisper-base.en", dtype = "q8"): Promise<Stt> {
  const tf: any = await import("@huggingface/transformers").catch(() => {
    throw new Error("Voice STT needs `@huggingface/transformers` — add it to run Whisper in the browser.");
  });
  const device = (navigator as any).gpu ? "webgpu" : "wasm";
  const asr = await tf.pipeline("automatic-speech-recognition", modelId, { device, dtype });
  return {
    async transcribe(pcm16k: Int16Array): Promise<string> {
      const audio = pcm16ToFloat32(pcm16k); // whisper wants Float32 mono @ 16 kHz
      const out = await asr(audio, { chunk_length_s: 30, stride_length_s: 5 });
      return String(out?.text ?? "").replace(/\s+/g, " ").trim();
    },
    async unload() { try { await asr?.dispose?.(); } catch { /* noop */ } },
  };
}
