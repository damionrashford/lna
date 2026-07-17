// AUTOMO's brain (public surface). Owns the live sandbox lifecycle, multi-conversation sessions
// (persisted as AI SDK UIMessages), workspace snapshots, composer state, and boot. Model building and
// connection live in ./build and ./connect (re-exported here so `from "./agent"` stays the entry point).
import { Manifest, gitRepo } from "@openai/agents/sandbox";
import { S, set, getState, setStatus, setMachine, setCap } from "../../store";
import { detectHardware, recommendModel, recommendFromBridge, bridgeSummary } from "@automo/inference";
import { probeBridgeHardware } from "../net/index";
import { idbGet, idbSet } from "../storage/idb";
import { getFsRoot } from "../storage/opfs";
import { BrowserSandboxClient, u8ToB64 } from "../sandbox/index";
import { cacheWorkspace, hydrateWorkspaceFromCache, dropWorkspaceCache, mirrorToFolder, requestDurable, importFromFolder, startFolderObserver, stopFolderObserver } from "../sandbox/persist";
import { acquireSandboxLock, releaseSandboxLock } from "../platform/locks";
import { broadcastSessions } from "../platform/tabs";
import { notifyRootsChanged } from "../mcp/index";
import { setWorkspaceRoot } from "../sandbox/roots";

export * from "./build";
export * from "./connect";

/* eslint-disable @typescript-eslint/no-explicit-any */
type UIMessage = any;

// the live sandbox for the current conversation — one workspace, reused across turns. Two backends:
// the bridge (real Unix on the machine) or the in-browser Pyodide sandbox (zero-install, sandboxed).
let sandboxClient: any = null;
let sandboxSession: any = null;
export async function ensureSandbox() {
  if (sandboxSession) return sandboxSession;
  if (!(await acquireSandboxLock())) throw new Error("Another AUTOMO tab is driving the sandbox — use that tab, or close it and retry.");
  if (S.sandbox === "inbrowser") {
    const { InBrowserSandboxClient } = await import("../sandbox/inbrowser/index");
    sandboxClient = new InBrowserSandboxClient();
    setCap("bridge", "ok", "in-browser sandbox (Pyodide)");
  } else {
    sandboxClient = new BrowserSandboxClient("ws://127.0.0.1:7967/ws", S.bridgeToken);
  }
  sandboxSession = await sandboxClient.create(new Manifest({ entries: {} }));
  const sid = getState().sessionId; // restore this conversation's durable workspace, if cached
  if (sid) await hydrateWorkspaceFromCache(sid, sandboxSession);
  if (getFsRoot()) startFolderObserver(sandboxSession); // auto-import folder edits (Chromium only)
  setWorkspaceRoot(sandboxSession.state?.workspaceRootPath ?? null); // expose as an MCP root
  notifyRootsChanged();
  return sandboxSession;
}
// manual "pull the granted folder into the workspace" (folder → sandbox); returns files imported
export async function importActiveFolder(): Promise<number> {
  return sandboxSession ? importFromFolder(sandboxSession) : 0;
}
// snapshot the live workspace → OPFS cache (durable across reloads) + mirror to the granted folder.
export async function persistActiveWorkspace() {
  const sid = getState().sessionId;
  if (!sid || !sandboxSession) return;
  await cacheWorkspace(sid, sandboxSession);
  if (getFsRoot()) await mirrorToFolder(sandboxSession);
}
export async function resetSandbox() {
  const old = sandboxSession;
  sandboxSession = null; releaseSandboxLock(); stopFolderObserver();
  // fire-and-forget: let memory generation (pre-stop hooks) flush to MEMORY.md in the background, then
  // close — so switching/clearing a conversation stays instant even though the flush runs the model.
  if (old) void (async () => {
    try { await old.runPreStopHooks?.(); } catch { /* best-effort */ }
    try { await old.close?.(); } catch { /* noop */ }
  })();
}

// ===== Sessions: persistent multi-conversation memory, stored as AI SDK UIMessage[] =====
const newSid = () => "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
function titleFromUi(msgs: UIMessage[]): string {
  const u = (msgs || []).find((m) => m.role === "user");
  const t = u ? (u.parts || []).filter((p: any) => p.type === "text").map((p: any) => p.text).join(" ") : "New chat";
  return (t || "New chat").slice(0, 42) || "New chat";
}
async function loadSessions() { set({ sessions: (await idbGet<any[]>("sessions")) || [] }); }
async function saveSessions() { await idbSet("sessions", getState().sessions); broadcastSessions(); }
export async function loadUiMessages(id: string): Promise<UIMessage[]> { return (await idbGet<UIMessage[]>("ui:" + id)) || []; }
export async function saveUiMessages(id: string, msgs: UIMessage[]) {
  await idbSet("ui:" + id, msgs);
  const sessions = getState().sessions.map((s) => (s.id === id ? { ...s, updated: Date.now(), title: !s.title || s.title === "New chat" ? titleFromUi(msgs) : s.title } : s));
  set({ sessions }); await saveSessions();
}
export async function switchSession(id: string) {
  set({ sessionId: id, plan: [] }); localStorage.setItem("automo.session", id); await resetSandbox();
}
export async function createSession() {
  const id = newSid();
  set({ sessions: [{ id, title: "New chat", updated: Date.now() }, ...getState().sessions] });
  await saveSessions(); await idbSet("ui:" + id, []); await switchSession(id);
}
export async function deleteSession(id: string) {
  set({ sessions: getState().sessions.filter((s) => s.id !== id) }); await saveSessions();
  try { await idbSet("ui:" + id, undefined); } catch { /* noop */ }
  await dropWorkspaceCache(id);
  if (getState().sessionId === id) { const rest = getState().sessions; rest.length ? await switchSession(rest[0].id) : await createSession(); }
}
async function initSessions() {
  await loadSessions();
  const saved = localStorage.getItem("automo.session"); const sessions = getState().sessions;
  if (sessions.find((s) => s.id === saved)) await switchSession(saved!);
  else if (sessions.length) await switchSession(sessions[0].id);
  else await createSession();
}

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

// ---- snapshot / resume: persist the real sandbox workspace + the conversation (UIMessages) ----
function loadSnaps() { set({ snaps: JSON.parse(localStorage.getItem("automo.snaps") || "[]") }); }
export async function snapshotWorkspace(name: string, uiMessages: UIMessage[]) {
  name = (name || "snapshot").trim();
  try {
    const session = await ensureSandbox();
    const tar = await session.persistWorkspace();
    await idbSet("snapshot:" + name, { at: Date.now(), items: uiMessages.slice(), tarB64: u8ToB64(tar) });
    const idx = JSON.parse(localStorage.getItem("automo.snaps") || "[]"); if (!idx.includes(name)) { idx.push(name); localStorage.setItem("automo.snaps", JSON.stringify(idx)); }
    loadSnaps();
  } catch (e: any) { set({ repoSt: "snapshot failed: " + (e?.message || e) }); }
}
// creates a fresh session, hydrates the workspace, and returns the snapshot's UIMessages for the chat layer
export async function restoreSnapshot(name: string): Promise<UIMessage[] | null> {
  const snap = await idbGet<any>("snapshot:" + name); if (!snap) return null;
  await createSession();
  if (snap.tarB64) { const session = await ensureSandbox(); await session.hydrateWorkspace(Uint8Array.from(atob(snap.tarB64), (c) => c.charCodeAt(0))); }
  const msgs = (snap.items || []).slice();
  await saveUiMessages(getState().sessionId!, msgs);
  return msgs;
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
  const { restoreFolder } = await import("../storage/opfs");
  const { reconnectSaved } = await import("../mcp/index");
  const { initWakeLock } = await import("../platform/wakelock");
  const { initTabs } = await import("../platform/tabs");
  const { initPwa } = await import("../platform/pwa");
  setStatus("", "not connected");
  const { installObservability } = await import("../runtime/context/trace");
  installObservability(); // SDK tracing → rich console + debug panel (chat + autonomous runs)
  // local profile → show the warm first-run welcome once (non-blocking), mirror the name for the greeting
  const { getProfile } = await import("../runtime/context/profile");
  const prof = getProfile();
  set({ onboarding: !prof.onboarded, profileName: prof.name });
  initWakeLock();
  initTabs();
  initPwa(); // Share Target / File Handlers / install prompt for the installed PWA
  if (S.autonomous) { const { startScheduler } = await import("../runtime/autonomy/scheduler"); startScheduler(); } // opt-in autonomous mode
  // detect the machine and recommend a model size (coarse browser APIs), then refine with the bridge's
  // exact RAM/VRAM/chip if it's running — WebGPU caps deviceMemory at 8 and hides VRAM, so a 64GB box
  // reads as 8GB until the bridge reports real numbers. Runs at idle (Background Tasks API) so it never
  // blocks first paint; the `timeout` guarantees it still fires on a busy main thread.
  const idle = (globalThis as any).requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 200));
  idle(() => {
    detectHardware().then(async (p) => {
      const rec = recommendModel(p);
      const summary = [p.gpuName, p.ramGiB ? `${p.ramGiB}GB` : null, p.mobile ? "mobile" : p.arch, p.platform].filter(Boolean).join(" · ");
      setMachine({ tier: rec.tier, note: rec.note, examples: rec.examples, summary });
      const hw = await probeBridgeHardware();
      if (hw?.ramGiB || hw?.vramGiB) {
        const exact = recommendFromBridge(hw, rec);
        setMachine({ tier: exact.tier, note: exact.note, examples: exact.examples, summary: bridgeSummary(hw) });
      }
    }).catch(() => { /* detection best-effort */ });
  }, { timeout: 2000 });
  restoreFolder();
  requestDurable(); // keep the OPFS workspace cache from being evicted
  loadSnaps();
  await initSessions();
  reconnectSaved();
}
