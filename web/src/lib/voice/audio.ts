// Browser audio I/O for the voice stack.
//   capture — getUserMedia -> inline AudioWorklet (Blob URL, no separate asset) posts mic frames to the
//     main thread, which downsamples to 16 kHz Int16 and runs an energy VAD. A completed utterance
//     (speech long enough, then silence) fires onUtterance.
//   playback — gapless queue of 24 kHz Int16 PCM scheduled on an AudioContext; stop() flushes it for
//     barge-in.
import { rms, downsampleTo16k, concatPcm, pcm16ToFloat32 } from "./pcm";
import type { VoiceConfig } from "./config";

/* eslint-disable @typescript-eslint/no-explicit-any */

// AudioWorklet that forwards each mono input quantum to the main thread. Inlined via Blob so the static
// build needs no separate worklet file.
const WORKLET_SRC = `class Cap extends AudioWorkletProcessor{process(i){const c=i[0]&&i[0][0];if(c)this.port.postMessage(c.slice(0));return true}}registerProcessor('vad-cap',Cap)`;

export class VoiceAudio {
  #cfg: VoiceConfig;
  #ctx: AudioContext | null = null;
  #stream: MediaStream | null = null;
  #node: AudioWorkletNode | null = null;

  // VAD state
  #utter: Float32Array[] = [];
  #speaking = false;
  #silenceMs = 0;
  #speechMs = 0;

  // playback
  #playCtx: AudioContext | null = null;
  #cursor = 0;
  #sources = new Set<AudioBufferSourceNode>();

  constructor(cfg: VoiceConfig) { this.#cfg = cfg; }

  async startCapture(onUtterance: (pcm16k: Int16Array) => void): Promise<void> {
    this.#stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
    const ctx = new AudioContext();
    this.#ctx = ctx;
    const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: "application/javascript" }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const src = ctx.createMediaStreamSource(this.#stream);
    const node = new AudioWorkletNode(ctx, "vad-cap");
    this.#node = node;
    const frameMs = 128 / ctx.sampleRate * 1000; // one render quantum
    node.port.onmessage = (e) => this.#onFrame(e.data as Float32Array, ctx.sampleRate, frameMs, onUtterance);
    src.connect(node);
    node.connect(ctx.destination); // required for the worklet to pull; gain is zero-audible for mic
  }

  #onFrame(frame: Float32Array, rate: number, frameMs: number, onUtterance: (pcm: Int16Array) => void) {
    const pcm = downsampleTo16k(frame, rate);
    const energy = rms(pcm);
    if (energy >= this.#cfg.vadStartRms) {
      this.#speaking = true; this.#silenceMs = 0; this.#speechMs += frameMs; this.#utter.push(frame);
    } else if (this.#speaking) {
      this.#utter.push(frame);
      if (energy < this.#cfg.vadEndRms) this.#silenceMs += frameMs; else this.#silenceMs = 0;
      if (this.#silenceMs >= this.#cfg.vadSilenceMs) {
        const speech = this.#speechMs; const raw = this.#utter; this.#resetVad();
        if (speech >= this.#cfg.vadMinSpeechMs) {
          const merged = new Float32Array(raw.reduce((n, f) => n + f.length, 0));
          let off = 0; for (const f of raw) { merged.set(f, off); off += f.length; }
          onUtterance(downsampleTo16k(merged, rate));
        }
      }
    }
  }
  #resetVad() { this.#utter = []; this.#speaking = false; this.#silenceMs = 0; this.#speechMs = 0; }

  stopCapture(): void {
    try { this.#node?.disconnect(); } catch { /* noop */ }
    this.#stream?.getTracks().forEach((t) => t.stop());
    try { void this.#ctx?.close(); } catch { /* noop */ }
    this.#node = null; this.#stream = null; this.#ctx = null; this.#resetVad();
  }

  // ---- playback (24 kHz Int16 PCM, gapless) ----
  enqueue(data: ArrayBuffer | Int16Array): void {
    const pcm = data instanceof Int16Array ? data : new Int16Array(data);
    if (!pcm.length) return;
    const ctx = (this.#playCtx ??= new AudioContext());
    if (ctx.state === "suspended") void ctx.resume();
    const buf = ctx.createBuffer(1, pcm.length, this.#cfg.ttsSampleRate);
    buf.getChannelData(0).set(pcm16ToFloat32(pcm));
    const node = ctx.createBufferSource();
    node.buffer = buf; node.connect(ctx.destination);
    const start = Math.max(ctx.currentTime, this.#cursor);
    node.start(start); this.#cursor = start + buf.duration;
    this.#sources.add(node);
    node.onended = () => this.#sources.delete(node);
  }
  stopPlayback(): void {
    for (const s of this.#sources) { try { s.stop(); } catch { /* already stopped */ } }
    this.#sources.clear();
    this.#cursor = this.#playCtx?.currentTime ?? 0;
  }

  // Buffer-concatenation helper for the transport; unused since capture emits whole utterances.
  static merge(chunks: Int16Array[]): Int16Array { return concatPcm(chunks); }
}
