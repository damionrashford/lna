// In-browser LLM chat via @mlc-ai/web-llm (MLC, WebGPU). A purpose-built LLM runtime — KV-cache,
// streaming, a real model registry — so it's a stronger CHAT brain than transformers.js (which AUTOMO
// keeps for ASR/TTS/embeddings). Conforms to the same BrowserEngine interface as transformers.ts, so
// runtime/browser-model.ts can drive either behind one SDK Model.
//
// Dep-gated dynamic import (variable specifier) → bundles WITHOUT `@mlc-ai/web-llm`; add it to run.
// Uses CreateMLCEngine (main-thread) to avoid shipping a separate worker asset; generation is offloaded
// to the GPU regardless. Ported from gh-pages-react/webllm.ts (model registry + VRAM metadata).
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { BrowserEngine } from "./transformers";

// Curated small→capable MLC models with VRAM (MB) + f16 gate (from gh-pages-react, verified against
// web-llm's prebuiltAppConfig). Static so the picker + device profiler work without loading the runtime.
type Meta = { vram: number; f16?: boolean };
const MODEL_META: Record<string, Meta> = {
  "SmolLM2-360M-Instruct-q4f16_1-MLC": { vram: 376, f16: true },
  "Qwen3-0.6B-q4f16_1-MLC": { vram: 1403 },
  "Llama-3.2-1B-Instruct-q4f16_1-MLC": { vram: 879 },
  "Qwen2.5-1.5B-Instruct-q4f16_1-MLC": { vram: 1630 },
  "gemma-2-2b-it-q4f16_1-MLC": { vram: 1895, f16: true },
  "Llama-3.2-3B-Instruct-q4f16_1-MLC": { vram: 2264 },
  "Phi-3.5-mini-instruct-q4f16_1-MLC": { vram: 3672 },
  "Llama-3.1-8B-Instruct-q4f32_1-MLC": { vram: 6101 },
};
export const WEBLLM_MODELS: string[] = Object.keys(MODEL_META);
export const webllmVramMB = (id: string): number | undefined => MODEL_META[id]?.vram;
export const webllmRequiresF16 = (id: string): boolean => Boolean(MODEL_META[id]?.f16);

export async function createWebllmEngine(model: string, onProgress?: (pct: number) => void): Promise<BrowserEngine> {
  const webllm: any = await import("@mlc-ai/web-llm").catch(() => {
    throw new Error("In-browser chat via web-llm needs `@mlc-ai/web-llm` — add it to run MLC models on WebGPU.");
  });
  const engine = await webllm.CreateMLCEngine(model, {
    initProgressCallback: (r: any) => onProgress?.(Math.round((r.progress ?? 0) * 100)),
  });
  return {
    model,
    async chat(messages, opts) {
      if (opts?.onToken) {
        const chunks = await engine.chat.completions.create({ messages, stream: true, temperature: 0 });
        let full = "";
        for await (const chunk of chunks) { const d = chunk.choices[0]?.delta?.content; if (d) { full += d; opts.onToken(d); } }
        return full;
      }
      const r = await engine.chat.completions.create({ messages, temperature: 0, max_tokens: opts?.maxNewTokens });
      return r.choices[0]?.message?.content ?? "";
    },
    async unload() { try { await engine.unload(); } catch { /* noop */ } },
  };
}
