// PCM helpers for the voice pipeline. Everything is signed 16-bit little-endian mono PCM. Whisper (STT)
// consumes 16 kHz; Kokoro (TTS) emits 24 kHz. Ported from voice-box/src/audio/pcm.ts (pure, framework-
// agnostic) with two browser-playback additions (pcm16ToFloat32, downsampleTo16k).

// Kokoro Float32 (-1..1) → Int16 LE PCM.
export function floatToPcm16(f32: Float32Array): Int16Array {
  const pcm = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return pcm;
}

// Int16 PCM → Float32 (-1..1), for feeding an AudioBuffer on playback.
export function pcm16ToFloat32(pcm: Int16Array): Float32Array {
  const f = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) f[i] = pcm[i] / (pcm[i] < 0 ? 0x8000 : 0x7fff);
  return f;
}

// Exact-length ArrayBuffer view of an Int16Array (handles non-zero byteOffset).
export function pcm16ToArrayBuffer(pcm: Int16Array): ArrayBuffer {
  return pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer;
}

// Root-mean-square energy of an int16 frame — the VAD signal.
export function rms(pcm: Int16Array): number {
  if (pcm.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
  return Math.sqrt(sum / pcm.length);
}

// Concatenate int16 chunks into one buffer.
export function concatPcm(chunks: Int16Array[]): Int16Array {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Int16Array(len);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

// Linear-resample a Float32 mic frame at `srcRate` down to 16 kHz Int16. The browser's AudioContext runs
// at 44.1/48 kHz; whisper needs exactly 16 kHz. Linear interpolation is enough for speech.
export function downsampleTo16k(f32: Float32Array, srcRate: number): Int16Array {
  if (srcRate === 16000) return floatToPcm16(f32);
  const ratio = srcRate / 16000;
  const outLen = Math.floor(f32.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const lo = Math.floor(pos), hi = Math.min(lo + 1, f32.length - 1);
    const s = f32[lo] + (f32[hi] - f32[lo]) * (pos - lo);
    const c = Math.max(-1, Math.min(1, s));
    out[i] = c < 0 ? c * 0x8000 : c * 0x7fff;
  }
  return out;
}
