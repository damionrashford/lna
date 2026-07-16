// In-browser inference via transformers.js (@huggingface/transformers) — ONNX Runtime Web on WebGPU
// (auto-falls back to WASM where WebGPU is absent). HF-native: any ONNX text-generation model on the
// Hub tagged `library=transformers.js`; quantization via `dtype` (q4 / q4f16 / q8 / fp16). Zero server,
// weights fetched from the Hub and cached in the browser Cache API. Streams tokens via TextStreamer.
//
// The heavy WASM dep is imported lazily via a runtime-resolved specifier so this module bundles WITHOUT
// `@huggingface/transformers` installed; add it to actually run the engine. API is grounded in the
// transformers.js v3 docs (pipeline text-generation, device:"webgpu", dtype, TextStreamer).
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface BrowserEngine {
  model: string;
  chat(messages: { role: string; content: string }[], opts?: { onToken?: (t: string) => void; maxNewTokens?: number }): Promise<string>;
  unload(): Promise<void>;
}

export async function createBrowserEngine(model: string, dtype = "q4f16"): Promise<BrowserEngine> {
  const spec = "@huggingface/transformers"; // variable specifier ⇒ not resolved at bundle time
  const tf: any = await import(/* @vite-ignore */ spec).catch(() => {
    throw new Error("In-browser engine needs `@huggingface/transformers` — add it to run models on WebGPU/WASM.");
  });
  const device = (navigator as any).gpu ? "webgpu" : "wasm";
  const generator = await tf.pipeline("text-generation", model, { device, dtype });
  return {
    model,
    async chat(messages, opts) {
      const streamer = opts?.onToken
        ? new tf.TextStreamer(generator.tokenizer, { skip_prompt: true, callback_function: opts.onToken })
        : undefined;
      const out = await generator(messages, { max_new_tokens: opts?.maxNewTokens ?? 512, do_sample: false, streamer });
      const gen = out?.[0]?.generated_text; // pipeline returns the full chat incl. the new assistant turn
      return Array.isArray(gen) ? (gen[gen.length - 1]?.content ?? "") : String(gen ?? "");
    },
    async unload() { try { await generator?.dispose?.(); } catch { /* noop */ } },
  };
}
