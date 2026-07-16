// Browser STT — Whisper via transformers.js (@huggingface/transformers), ONNX Runtime Web on WebGPU
// (WASM fallback). Replaces voice-box's nodejs-whisper (which shells out to whisper.cpp) with a fully
// in-browser pipeline. Same contract the transport expects: transcribe(16 kHz mono Int16) → clean text.
//
// The heavy dep is a runtime-resolved dynamic import (variable specifier) so this module bundles WITHOUT
// `@huggingface/transformers`; add it to actually run. API grounded in the transformers.js v3 ASR docs
// (pipeline "automatic-speech-recognition", Float32 @ 16 kHz input, {device, dtype}).
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
