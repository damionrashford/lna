// Zero-download voice output via the platform SpeechSynthesis engine — the fallback when kokoro-js isn't
// installed. It speaks through the OS voice directly rather than emitting PCM, so the transport's onPcm is
// unused; barge-in still works because the transport calls cancel() on interruption. Text streams in as
// deltas and is spoken at sentence boundaries to keep latency low.
import type { TtsEngine, TtsSession } from "./tts";

export function nativeTtsSupported(): boolean {
  return typeof speechSynthesis !== "undefined" && typeof SpeechSynthesisUtterance !== "undefined";
}

export class NativeTts implements TtsEngine {
  constructor(private rate = 1) {}
  createSession(opts: { voice: string; speed: number }): TtsSession {
    return new NativeSession(opts.speed || this.rate);
  }
}

class NativeSession implements TtsSession {
  #buf = "";
  #rate: number;
  #cancelled = false;
  constructor(rate: number) { this.#rate = rate; }

  push(token: string): void {
    if (this.#cancelled) return;
    this.#buf += token;
    // Flush complete sentences as they arrive; the tail waits for end().
    const cut = Math.max(this.#buf.lastIndexOf(". "), this.#buf.lastIndexOf("! "), this.#buf.lastIndexOf("? "), this.#buf.lastIndexOf("\n"));
    if (cut >= 0) { this.#speak(this.#buf.slice(0, cut + 1)); this.#buf = this.#buf.slice(cut + 1); }
  }

  async end(): Promise<void> {
    if (this.#cancelled) return;
    this.#speak(this.#buf); this.#buf = "";
  }

  cancel(): void {
    this.#cancelled = true; this.#buf = "";
    try { speechSynthesis.cancel(); } catch { /* engine unavailable */ }
  }

  #speak(text: string): void {
    const t = text.trim();
    if (!t) return;
    const u = new SpeechSynthesisUtterance(t);
    u.rate = this.#rate;
    speechSynthesis.speak(u);
  }
}
