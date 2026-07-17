// Off-main-thread host for Whisper speech-to-text. Transcription blocks for hundreds of ms per utterance;
// running it here keeps the UI and audio playback responsive during a spoken turn. Built to
// dist/voice-worker.js by scripts/build.ts.
import { createStt, type Stt } from "./asr";

/* eslint-disable @typescript-eslint/no-explicit-any */
let stt: Stt | null = null;
let loaded = "";

async function sttFor(model: string, dtype: string): Promise<Stt> {
  const key = model + "|" + dtype;
  if (stt && loaded === key) return stt;
  if (stt) { try { await stt.unload(); } catch { /* best-effort */ } stt = null; }
  loaded = key;
  stt = await createStt(model, dtype);
  return stt;
}

self.addEventListener("message", async (e: MessageEvent) => {
  const d: any = e.data;
  const post = (m: any) => (self as any).postMessage({ id: d.id, ...m });
  try {
    if (d.op === "ping") post({ ok: true });
    else if (d.op === "transcribe") post({ ok: true, text: await (await sttFor(d.model, d.dtype)).transcribe(d.pcm) });
    else if (d.op === "unload") { if (stt) { try { await stt.unload(); } catch { /* best-effort */ } stt = null; loaded = ""; } post({ ok: true }); }
  } catch (err: any) {
    post({ ok: false, error: err?.message ?? String(err) });
  }
});
