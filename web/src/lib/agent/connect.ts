// Connection and model discovery for the selected inference backend, plus browser-triggered model
// pull and image generation. connect() drives the ConnectGate diagnostics.
import { S, trimUrl, set, getState, setStatus, setCap } from "../../store";
import { providerFor } from "@automo/inference";
import { localFetch, probeReachable, probeBridge } from "../net/index";
import { viewTransition } from "../platform/transitions";

/* eslint-disable @typescript-eslint/no-explicit-any */

export function activeProvider() {
  return providerFor(S.provider as any, { ollamaUrl: S.url, vllmUrl: S.vllmUrl, hfToken: S.hfToken });
}

export async function connect() {
  set({ connecting: true, diag: { show: false, html: "" } });
  setStatus("busy", "connecting…");
  const t0 = performance.now();
  try {
    const models = await refreshModels();
    if (!models.length) { showDiag("no-model"); return failConnect(); }
    onConnected(models);
  } catch (err: any) {
    const ms = Math.round(performance.now() - t0);
    const reachable = await probeReachable();
    showDiag(reachable ? "cors" : diagnose(err, ms));
    failConnect();
  }
}

export async function refreshModels(): Promise<string[]> {
  const provider = activeProvider();
  let models: string[];
  if (provider.kind === "ollama") {
    // Ollama uses /api/tags; throwing on non-ok drives connect()'s CORS/unreachable diagnostics.
    const res = await localFetch(trimUrl() + "/api/tags", { method: "GET" });
    if (!res.ok) throw new Error(`Ollama replied HTTP ${res.status}`);
    models = ((await res.json()).models || []).map((m: any) => m.name);
  } else {
    models = await provider.listModels(localFetch as any);
  }
  const image = models.filter((m) => /flux|stable|sdxl|\bsd\d|diffus|image-?gen|dalle/i.test(m));
  const vision = models.filter((m) => /vl\b|-vl|vision|llava|multimodal|moondream/i.test(m));
  const chat = models.filter((m) => !image.includes(m));
  S.model = chat.includes(S.model) ? S.model : chat[0] || "";
  S.vision = vision.includes(S.vision) ? S.vision : vision[0] || "";
  S.image = image.includes(S.image) ? S.image : image[0] || "";
  set({ models: { chat, vision, image } });
  return models;
}

function failConnect() { set({ connecting: false, connected: false }); setStatus("err", "not connected"); setCap("model", "err", "blocked"); }
export function onConnected(models: string[]) {
  viewTransition(() => set({ connected: true, connecting: false }));
  setStatus("ok", "connected"); setCap("model", "ok", `${models.length} model${models.length > 1 ? "s" : ""}`);
  probeBridge();
}
function diagnose(err: any, ms: number): string {
  const httpToHttps = /^http:\/\//.test(S.url) && location.protocol === "https:";
  if (/Failed to fetch|NetworkError|load failed/i.test(err.message) && ms < 60 && httpToHttps) return "blocked";
  if (/Failed to fetch|NetworkError|load failed/i.test(err.message)) return "unreachable";
  return "other:" + err.message;
}
function showDiag(kind: string) {
  const origin = location.origin;
  const map: Record<string, string> = {
    cors: `<b>Ollama is running, but not allowing this page.</b> It answered a probe, so LNA + the connection are fine — it's a CORS block. Restart it allowing this origin:<ul>
      <li><code>OLLAMA_ORIGINS='${origin}' ollama serve</code></li>
      <li>(macOS app) <code>launchctl setenv OLLAMA_ORIGINS '${origin}'</code> then restart Ollama.</li></ul>`,
    blocked: `<b>Couldn't reach your model.</b> Most likely one of:<ul>
      <li>You denied (or haven't seen) the <b>local-network</b> prompt — reload and click Allow.</li>
      <li>Ollama isn't allowing this page — start it with <code>OLLAMA_ORIGINS='${origin}'</code>.</li>
      <li>On Chrome &lt; 142, enable <code>chrome://flags/#local-network-access-check</code>.</li></ul>`,
    unreachable: `<b>Ollama isn't responding at ${S.url}.</b><ul>
      <li>Is it running? <code>ollama serve</code></li>
      <li>Right port? Default is <code>11434</code>.</li></ul>`,
    "no-model": `<b>Connected, but no models are installed.</b><ul>
      <li>Pull one: <code>ollama pull llama3.2</code>, then Connect again.</li></ul>`,
  };
  set({ diag: { show: true, html: map[kind] || `<b>Connection error.</b> ${kind.replace("other:", "")}` } });
}

// Pull a model via Ollama's /api/pull (NDJSON progress stream), driven from the browser.
export async function pullModel(name: string) {
  name = (name || "").trim(); if (!name) return;
  set({ pull: { show: true, pct: 0, text: "starting…" } });
  try {
    const res = await localFetch(trimUrl() + "/api/pull", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: name, stream: true }) });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true }); let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue;
        let o: any; try { o = JSON.parse(line); } catch { continue; }
        if (o.error) throw new Error(o.error);
        if (o.total && o.completed) { const p = Math.round((o.completed / o.total) * 100); set({ pull: { show: true, pct: p, text: `${o.status} · ${p}%` } }); }
        else set({ pull: { show: true, pct: getState().pull.pct, text: o.status || "…" } });
      }
    }
    set({ pull: { show: true, pct: 100, text: "done ✓" } });
    await refreshModels();
    if (!getState().connected) { setStatus("ok", "connected"); onConnected(await refreshModels()); }
  } catch (err: any) { set({ pull: { show: true, pct: getState().pull.pct, text: "failed: " + err.message } }); }
}

// Image generation (/v1/images/generations); returns a data URL for the chat layer.
export async function generateImageData(prompt: string): Promise<{ dataUrl: string; caption: string }> {
  if (!S.image) throw new Error("pick an image model in settings");
  const res = await localFetch(trimUrl() + "/v1/images/generations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: S.image, prompt, size: "512x512", response_format: "b64_json" }) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const b64 = (await res.json()).data?.[0]?.b64_json;
  if (!b64) throw new Error("no image returned");
  return { dataUrl: "data:image/png;base64," + b64, caption: `${S.image} · "${prompt}"` };
}
