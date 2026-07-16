// Browser TTS — Kokoro via kokoro-js (ONNX in the browser on WebGPU). Ported from voice-box/src/tts/
// kokoro.ts; the ONE change is device "cpu" (onnxruntime-node) → "webgpu" (browser). Streaming, sentence-
// by-sentence synthesis so the first audio plays while the model is still generating (low latency).
//
// kokoro-js is a runtime-resolved dynamic import (variable specifier) so this bundles WITHOUT the dep;
// add `kokoro-js` to actually synthesize. Emits 24 kHz Int16 mono to the transport's onPcm.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { floatToPcm16 } from "./pcm";

export interface TtsSession {
  push(token: string): void;
  end(): Promise<void>;
  cancel(): void;
}

export class Tts {
  #tts: any = null;
  constructor(private modelId: string, private dtype: string, private defaultVoice: string) {}

  async load(): Promise<void> {
    const mod: any = await import("kokoro-js").catch(() => {
      throw new Error("Voice TTS needs `kokoro-js` — add it to run Kokoro in the browser.");
    });
    const device = (navigator as any).gpu ? "webgpu" : "wasm";
    this.#tts = await mod.KokoroTTS.from_pretrained(this.modelId, { dtype: this.dtype, device });
    (this.#tts as any).__mod = mod; // keep TextSplitterStream reachable for sessions
  }

  get voices(): string[] { return this.#tts ? Object.keys((this.#tts as any).voices ?? {}) : []; }

  createSession(opts: { voice: string; speed: number }, onPcm: (pcm: Int16Array) => void): TtsSession {
    if (!this.#tts) throw new Error("Tts.load() not called");
    return new KokoroSession(this.#tts, (this.#tts as any).__mod, { voice: opts.voice || this.defaultVoice, speed: opts.speed }, onPcm);
  }
}

class KokoroSession implements TtsSession {
  #splitter: any;
  #done: Promise<void>;
  #cancelled = false;

  constructor(tts: any, mod: any, opts: { voice: string; speed: number }, onPcm: (pcm: Int16Array) => void) {
    this.#splitter = new mod.TextSplitterStream();
    const stream = tts.stream(this.#splitter, { voice: opts.voice, speed: opts.speed });
    this.#done = (async () => {
      for await (const { audio } of stream) {
        if (this.#cancelled) break;
        onPcm(floatToPcm16(audio.audio as Float32Array));
      }
    })().catch(() => {});
  }
  push(token: string): void { if (!this.#cancelled) this.#splitter.push(token); }
  async end(): Promise<void> {
    if (!this.#cancelled) { try { this.#splitter.close(); } catch { /* already closed */ } }
    await this.#done;
  }
  cancel(): void { this.#cancelled = true; try { this.#splitter.close(); } catch { /* ignore */ } }
}
