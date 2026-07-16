// AUTOMO's brain — a real @openai/agents SandboxAgent running in the browser.
// Inference hits the local Ollama /v1/responses over LNA (via the shim); the sandbox
// (shell, filesystem/apply_patch, skills, memory, compaction) is the genuine SDK, hosted
// on the machine by the bridge and reached over LNA. This module also owns connection,
// multi-conversation sessions, and multimodal (vision + image gen).
import { run } from "@openai/agents";
import { Manifest, SandboxAgent, shell, filesystem, skills, memory, compaction, gitRepo } from "@openai/agents/sandbox";
import {
  S, trimUrl, set, getState, setStatus, setCap,
  pushThread, patchThread, moveThreadToEnd, setThread, type ThreadItem,
} from "../store";
import { localFetch, probeReachable } from "./net";
import { idbGet, idbSet } from "./idb";
import { getFsRoot } from "./opfs";
import { probeBridge } from "./tools";
import { mcpServers } from "./mcp";
import { installOllamaShim } from "./ollama";
import { BrowserSandboxClient } from "./sandbox";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Item = any;

let messages: Item[] = []; // persisted conversation history (SDK run input/history)

// the live sandbox for the current conversation — one real Unix workspace, reused across turns
let sandboxClient: BrowserSandboxClient | null = null;
let sandboxSession: any = null;
async function ensureSandbox() {
  if (sandboxSession) return sandboxSession;
  sandboxClient ??= new BrowserSandboxClient();
  sandboxSession = await sandboxClient.create(new Manifest({ entries: {} }));
  return sandboxSession;
}
async function resetSandbox() {
  try { await sandboxSession?.close(); } catch { /* noop */ }
  sandboxSession = null;
}

// ===== Sessions: persistent multi-conversation memory (IndexedDB) =====
const newSid = () => "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
function titleFrom(items: Item[]): string {
  const u = (items || []).find((m) => m.role === "user");
  const t = u ? (typeof u.content === "string" ? u.content : "chat") : "New chat";
  return t.slice(0, 42) || "New chat";
}
async function loadSessions() { set({ sessions: (await idbGet<any[]>("sessions")) || [] }); }
async function saveSessions() { await idbSet("sessions", getState().sessions); }
async function sessGetItems(id: string): Promise<Item[]> { return (await idbGet<Item[]>("session:" + id)) || []; }
async function sessSetItems(id: string, items: Item[]) {
  await idbSet("session:" + id, items);
  const sessions = getState().sessions.map((s) => (s.id === id ? { ...s, updated: Date.now(), title: !s.title || s.title === "New chat" ? titleFrom(items) : s.title } : s));
  set({ sessions }); await saveSessions();
}
export async function persistSession() { if (getState().sessionId) await sessSetItems(getState().sessionId!, messages); }
export async function switchSession(id: string) {
  set({ sessionId: id }); localStorage.setItem("automo.session", id);
  messages = await sessGetItems(id); await resetSandbox(); rebuildThread();
}
export async function createSession() {
  const id = newSid();
  set({ sessions: [{ id, title: "New chat", updated: Date.now() }, ...getState().sessions] });
  await saveSessions(); await idbSet("session:" + id, []); await switchSession(id);
}
export async function deleteSession(id: string) {
  set({ sessions: getState().sessions.filter((s) => s.id !== id) }); await saveSessions();
  try { await idbSet("session:" + id, undefined); } catch { /* noop */ }
  if (getState().sessionId === id) { const rest = getState().sessions; rest.length ? await switchSession(rest[0].id) : await createSession(); }
}
async function initSessions() {
  await loadSessions();
  const saved = localStorage.getItem("automo.session"); const sessions = getState().sessions;
  if (sessions.find((s) => s.id === saved)) await switchSession(saved!);
  else if (sessions.length) await switchSession(sessions[0].id);
  else await createSession();
}

// rebuild the render thread from persisted history (tool chips are live-only)
function rebuildThread() {
  const items: ThreadItem[] = messages
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content)
    .map((m) => ({ id: Math.random().toString(36).slice(2, 9), kind: "msg" as const, role: m.role, text: m.content }));
  setThread(items);
}

// ---- connect ----
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
  const res = await localFetch(trimUrl() + "/api/tags", { method: "GET" });
  if (!res.ok) throw new Error(`Ollama replied HTTP ${res.status}`);
  const models: string[] = ((await res.json()).models || []).map((m: any) => m.name);
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
function onConnected(models: string[]) {
  set({ connected: true, connecting: false });
  setStatus("ok", "connected"); setCap("model", "ok", `${models.length} model${models.length > 1 ? "s" : ""}`);
  probeBridge(); rebuildThread();
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

// pull a model FROM THE BROWSER (POST /api/pull, NDJSON progress)
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

// ---- system instructions (static + live run context) ----
const DEFAULT_INSTRUCTIONS = `You are AUTOMO, a local-first AI assistant running in the user's browser, connected to their own machine over Local Network Access. You operate a real Unix sandbox on their machine:
- shell (exec_command): run commands in the workspace.
- filesystem + apply_patch: read and edit files in the workspace.
- skills: load reusable skills on demand.
- memory: persist durable notes across sessions.
Prefer tools over guessing. Read a file before answering questions about it. Be concise and direct.`;
export function buildInstructions(): string {
  const base = S.instructions.trim() || DEFAULT_INSTRUCTIONS;
  const folder = getFsRoot() ? getFsRoot().name : "none";
  const mcp = mcpServers.filter((s) => s.connected).map((s) => s.label);
  const now = new Date().toISOString().slice(0, 10);
  return `${base}\n\n[Run context — model: ${S.model || "unknown"} · granted folder: ${folder} · MCP servers: ${mcp.length ? mcp.join(", ") : "none"} · date: ${now}]`;
}

// build the SandboxAgent with the full capability set
function buildAgent(): any {
  const model = S.model;
  return new SandboxAgent({
    name: "AUTOMO",
    model,
    instructions: buildInstructions(),
    defaultManifest: new Manifest({ entries: {} }),
    capabilities: [
      shell(),
      filesystem(),
      skills({
        lazyFrom: {
          source: gitRepo({ host: "github.com", repo: "damionrashford/lna", ref: "main", subpath: ".agents/skills" }),
          index: [{ name: "sum-writer", description: "Compute a sum and write it to a file (from the lna repo)." }],
        },
      }),
      memory({ generate: { phaseOneModel: model, phaseTwoModel: model } }),
      compaction(),
    ],
  });
}

// ---- one streaming turn through the SDK Runner, rendered into the store ----
async function runTurn(input: Item[]) {
  installOllamaShim(S.model);
  const agent = buildAgent();
  const session = await ensureSandbox();

  const botId = pushThread({ kind: "msg", role: "assistant", text: "", thinking: true, streaming: true });
  const chips = new Map<string, string>(); // toolCallId → thread id
  let text = "";

  const stream: any = await run(agent, input as any, { sandbox: { session }, stream: true, maxTurns: 24 } as any);

  for await (const ev of stream) {
    if (ev.type === "raw_model_stream_event") {
      const d = ev.data || {};
      const delta = d.delta ?? (typeof d.type === "string" && d.type.includes("output_text") ? d.delta : undefined);
      if (typeof delta === "string" && delta) { text += delta; patchThread(botId, { text, thinking: false, streaming: true }); }
    } else if (ev.type === "run_item_stream_event") {
      const it = ev.item, raw = it?.rawItem || {};
      if (ev.name === "tool_called") {
        const key = raw.callId || raw.id || raw.name || Math.random().toString(36).slice(2);
        const argsStr = typeof raw.arguments === "string" ? raw.arguments : JSON.stringify(raw.arguments ?? {});
        const cid = pushThread({ kind: "tool", name: raw.name || "tool", argsStr });
        chips.set(key, cid); moveThreadToEnd(botId);
      } else if (ev.name === "tool_output") {
        const key = raw.callId || raw.id;
        const cid = (key && chips.get(key)) || [...chips.values()].pop();
        if (cid) { let out: any = raw.output ?? it?.output ?? ""; if (typeof out !== "string") out = JSON.stringify(out); patchThread(cid, { result: "→ " + out.slice(0, 60) }); }
        moveThreadToEnd(botId);
      } else if (ev.name === "reasoning_item_created") {
        if (!text) patchThread(botId, { thinking: true, text: "" });
      }
    }
  }
  const result: any = await stream.completed ?? stream;
  const finalText = (result?.finalOutput != null ? String(result.finalOutput) : text) || text || "(done)";
  patchThread(botId, { streaming: false, thinking: false, text: finalText });
  return result;
}

// text chat via the SandboxAgent (Responses, streaming). Vision + image gen stay direct.
export async function send(text: string) {
  text = text.trim();
  const st = getState();
  if (st.streaming) return;
  if (st.imageMode) { if (text) generateImage(text); return; }
  const img = st.attached;
  if (!text && !img) return;
  set({ attached: null, streaming: true });

  pushThread({ kind: "msg", role: "user", text, image: img || undefined });

  try {
    if (img) { await visionTurn(text, img); }
    else {
      const input = [...messages, { role: "user", content: text }];
      const result = await runTurn(input);
      messages = (result?.history as Item[]) || [...input, { role: "assistant", content: getLastText() }];
    }
    await persistSession();
  } catch (err: any) {
    pushThread({ kind: "msg", role: "assistant", text: `Couldn't complete the turn (${err?.message || err}). Check the connection + bridge in settings.`, err: true });
    setStatus("err", "run failed");
  } finally { set({ streaming: false }); }
}
function getLastText(): string {
  const t = getState().thread; for (let i = t.length - 1; i >= 0; i--) { const x = t[i]; if (x.kind === "msg" && x.role === "assistant") return x.text; } return "";
}

// vision: a direct Responses call with an image (SandboxAgent turns are text)
async function visionTurn(text: string, img: string) {
  const botId = pushThread({ kind: "msg", role: "assistant", text: "", thinking: true, streaming: true });
  const model = S.vision || S.model;
  const res = await localFetch(trimUrl() + "/v1/responses", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, stream: false, input: [{ role: "user", content: [{ type: "input_text", text: text || "Describe this image." }, { type: "input_image", image_url: img }] }] }),
  });
  const d = await res.json();
  const out = (d.output || []).flatMap((it: any) => it.content || []).filter((c: any) => c.type === "output_text").map((c: any) => c.text).join("") || "(no description)";
  patchThread(botId, { streaming: false, thinking: false, text: out });
  messages.push({ role: "user", content: text ? text + " [image]" : "[image]" }, { role: "assistant", content: out });
}

// image generation (/v1/images/generations, e.g. flux)
export async function generateImage(prompt: string) {
  set({ streaming: true });
  pushThread({ kind: "msg", role: "user", text: prompt });
  messages.push({ role: "user", content: prompt });
  const botId = pushThread({ kind: "msg", role: "assistant", text: "generating…", thinking: true, streaming: true });
  try {
    if (!S.image) throw new Error("pick an image model in settings");
    const res = await localFetch(trimUrl() + "/v1/images/generations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: S.image, prompt, size: "512x512", response_format: "b64_json" }) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const b64 = (await res.json()).data?.[0]?.b64_json;
    if (!b64) throw new Error("no image returned");
    patchThread(botId, { thinking: false, streaming: false, text: "", genImage: "data:image/png;base64," + b64, genCaption: `${S.image} · "${prompt}"` });
    messages.push({ role: "assistant", content: `[generated image: ${prompt}]` }); await persistSession();
  } catch (err: any) {
    patchThread(botId, { thinking: false, streaming: false, err: true, text: `Image generation failed (${err.message}).` });
  } finally { set({ streaming: false }); }
}

// compaction is a SandboxAgent capability now; this button forces a fresh sandbox + trims history client-side as a fallback
export async function compactNow(_force: boolean) {
  const keep = 6;
  if (messages.length <= keep + 1) return;
  messages = messages.slice(-keep);
  await persistSession(); rebuildThread();
}
export async function clearConversation() { messages = []; await resetSandbox(); await persistSession(); rebuildThread(); }

// ---- workspace: clone a GitHub repo into the sandbox (materializeEntry via the manifest) ----
export async function addRepo(spec: string) {
  const setSt = (t: string) => set({ repoSt: t });
  const m = spec.trim().replace(/^https?:\/\/github\.com\//, "").match(/^([^/]+)\/([^@/#\s]+)(?:[@#](.+))?$/);
  if (!m) return setSt("use owner/repo (optionally @ref)");
  let [, owner, repo, ref] = m; repo = repo.replace(/\.git$/, "");
  try {
    setSt("materializing into sandbox…");
    const session = await ensureSandbox();
    const entry = gitRepo({ host: "github.com", repo: `${owner}/${repo}`, ref: ref || "main" } as any);
    await session.materializeEntry({ path: `repos/${owner}_${repo}`, entry });
    setSt(`✓ ${owner}/${repo} → sandbox repos/${owner}_${repo}/ (the agent can shell/read it)`);
  } catch (err: any) { setSt("failed: " + (err?.message || err)); }
}

// ---- snapshot / resume: persist the real sandbox workspace + conversation ----
function loadSnaps() { set({ snaps: JSON.parse(localStorage.getItem("automo.snaps") || "[]") }); }
export async function snapshotWorkspace(name: string) {
  name = (name || "snapshot").trim();
  try {
    const session = await ensureSandbox();
    const tar = await session.persistWorkspace();
    await idbSet("snapshot:" + name, { at: Date.now(), items: messages.slice(), tarB64: btoa(String.fromCharCode(...tar)) });
    const idx = JSON.parse(localStorage.getItem("automo.snaps") || "[]"); if (!idx.includes(name)) { idx.push(name); localStorage.setItem("automo.snaps", JSON.stringify(idx)); }
    loadSnaps();
  } catch (e: any) { set({ repoSt: "snapshot failed: " + (e?.message || e) }); }
}
export async function restoreSnapshot(name: string) {
  const snap = await idbGet<any>("snapshot:" + name); if (!snap) return;
  await createSession();
  if (snap.tarB64) { const session = await ensureSandbox(); await session.hydrateWorkspace(Uint8Array.from(atob(snap.tarB64), (c) => c.charCodeAt(0))); }
  messages = (snap.items || []).slice(); await persistSession(); rebuildThread();
}
export function deleteSnapshot(name: string) {
  const idx = JSON.parse(localStorage.getItem("automo.snaps") || "[]").filter((x: string) => x !== name);
  localStorage.setItem("automo.snaps", JSON.stringify(idx)); idbSet("snapshot:" + name, undefined); loadSnaps();
}

// ---- multimodal composer state ----
export function setAttachment(dataUrl: string) { if (getState().imageMode) set({ imageMode: false }); set({ attached: dataUrl }); }
export function clearAttachment() { set({ attached: null }); }
export function toggleImageMode() { const on = !getState().imageMode; set({ imageMode: on, attached: on ? null : getState().attached }); }

// ---- boot ----
export async function boot() {
  const { restoreFolder } = await import("./opfs");
  const { reconnectSaved } = await import("./mcp");
  setStatus("", "not connected");
  restoreFolder();
  loadSnaps();
  await initSessions();
  reconnectSaved();
}
