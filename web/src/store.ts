// Tiny external store: a single immutable-at-top-level state object that React
// subscribes to via useSyncExternalStore. Action modules mutate through set().
import { useSyncExternalStore } from "react";

export type Cap = { dot: string; text: string };

export type ThreadItem =
  | { id: string; kind: "msg"; role: "user" | "assistant"; text: string; image?: string; err?: boolean; thinking?: boolean; streaming?: boolean; genImage?: string; genCaption?: string }
  | { id: string; kind: "tool"; name: string; argsStr: string; result?: string }
  | { id: string; kind: "approve"; name: string; argsStr: string; onDecision: (ok: boolean) => void };

export type McpView = { label: string; transport: string; connected: boolean; error: string | null; tools: number };
export type LogEntry = { t: number; level: "info" | "warn" | "error"; msg: string };
export type Usage = { requests: number; input: number; output: number; total: number };
export type TaskInfo = { server: string; tool: string; status: string; t: number };
export type MachineInfo = { tier: string; note: string; examples: string[]; summary: string };
export type VoiceState = { active: boolean; state: "idle" | "loading" | "listening" | "thinking" | "speaking" };
export type PlanStep = { title: string; status: "pending" | "in_progress" | "completed" };

export interface State {
  status: { state: string; text: string };
  connected: boolean;
  connecting: boolean;
  caps: { model: Cap; bridge: Cap; files: Cap };
  models: { chat: string[]; vision: string[]; image: string[] };
  diag: { show: boolean; html: string };
  thread: ThreadItem[];
  streaming: boolean;
  attached: string | null;
  imageMode: boolean;
  sessions: { id: string; title: string; updated: number }[];
  sessionId: string | null;
  mcpView: McpView[];
  fsName: string;
  drawerOpen: boolean;
  pull: { show: boolean; pct: number; text: string };
  snaps: string[];
  repoSt: string;
  logs: LogEntry[];
  usage: Usage | null;
  debugOpen: boolean;
  tasks: TaskInfo[];
  machine: MachineInfo | null;
  voice: VoiceState;
  intake: string | null;   // text shared/opened into the installed PWA, to prefill the composer
  canInstall: boolean;     // a beforeinstallprompt was captured (show an Install affordance)
  onboarding: boolean;     // show the first-run welcome (non-blocking)
  profileName: string;     // reactive mirror of the local profile name, for the greeting
  plan: PlanStep[];        // the agent's live plan (from the update_plan tool)
}

let state: State = {
  status: { state: "", text: "not connected" },
  connected: false,
  connecting: false,
  caps: {
    model: { dot: "", text: "—" },
    bridge: { dot: "", text: "—" },
    files: { dot: "", text: "opt-in" },
  },
  models: { chat: [], vision: [], image: [] },
  diag: { show: false, html: "" },
  thread: [],
  streaming: false,
  attached: null,
  imageMode: false,
  sessions: [],
  sessionId: null,
  mcpView: [],
  fsName: "none",
  drawerOpen: false,
  pull: { show: false, pct: 0, text: "" },
  snaps: [],
  repoSt: "",
  logs: [],
  usage: null,
  debugOpen: false,
  tasks: [],
  machine: null,
  voice: { active: false, state: "idle" },
  intake: null,
  canInstall: false,
  onboarding: false,
  profileName: "",
  plan: [],
};

const listeners = new Set<() => void>();
export function getState(): State { return state; }
export function set(partial: Partial<State>) { state = { ...state, ...partial }; listeners.forEach((l) => l()); }
export function subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }
export function useStore(): State { return useSyncExternalStore(subscribe, getState, getState); }

const uid = () => Math.random().toString(36).slice(2, 9);

// distributive Omit so the ThreadItem discriminated union survives
type WithOptId<T> = T extends unknown ? Omit<T, "id"> & { id?: string } : never;

// thread helpers — all go through set() so React re-renders
export function pushThread(item: WithOptId<ThreadItem>): string {
  const id = item.id ?? uid();
  set({ thread: [...state.thread, { ...item, id } as ThreadItem] });
  return id;
}
export function patchThread(id: string, patch: Partial<ThreadItem>) {
  set({ thread: state.thread.map((t) => (t.id === id ? ({ ...t, ...patch } as ThreadItem) : t)) });
}
export function removeThread(id: string) { set({ thread: state.thread.filter((t) => t.id !== id) }); }
export function setThread(items: ThreadItem[]) { set({ thread: items }); }
export function moveThreadToEnd(id: string) {
  const item = state.thread.find((t) => t.id === id); if (!item) return;
  set({ thread: [...state.thread.filter((t) => t.id !== id), item] });
}

// structured run log — a capped ring buffer surfaced in the debug panel; also echoed to the console with a
// styled AUTOMO badge (%c) so app logs stand out from library noise in devtools.
const LOG_BADGE = "background:oklch(76% 0.14 32);color:#181016;padding:1px 6px;border-radius:4px;font-weight:700";
export function logEvent(level: LogEntry["level"], msg: string) {
  (level === "error" ? console.error : level === "warn" ? console.warn : console.info)("%cAUTOMO%c " + msg, LOG_BADGE, "");
  set({ logs: [...state.logs.slice(-199), { t: Date.now(), level, msg }] });
}
export function setUsage(u: Usage | null) { set({ usage: u }); }
export function setMachine(m: MachineInfo | null) { set({ machine: m }); }
export function setVoice(v: VoiceState) { set({ voice: v }); }
export function setIntake(text: string | null) { set({ intake: text }); }
export function setCanInstall(v: boolean) { set({ canInstall: v }); }
export function setOnboarding(v: boolean) { set({ onboarding: v }); }
export function setProfileName(v: string) { set({ profileName: v }); }
export function setPlan(v: PlanStep[]) { set({ plan: v }); }

// upsert MCP task status (keyed by server+tool) for the debug panel's background-task view
export function updateTask(server: string, tool: string, status: string) {
  const key = server + "/" + tool;
  const rest = state.tasks.filter((t) => t.server + "/" + t.tool !== key);
  set({ tasks: [...rest, { server, tool, status, t: Date.now() }].slice(-30) });
}

export function setStatus(st: string, text: string) { set({ status: { state: st, text } }); }
export function setCap(key: "model" | "bridge" | "files", dot: string, text: string) {
  set({ caps: { ...state.caps, [key]: { dot, text } } });
}

// ---- settings: localStorage-backed, read/written directly (not reactive) ----
export const S = {
  get url() { return localStorage.getItem("automo.url") || "http://localhost:11434"; },
  set url(v: string) { localStorage.setItem("automo.url", v); },
  get model() { return localStorage.getItem("automo.model") || ""; },
  set model(v: string) { localStorage.setItem("automo.model", v); },
  get vision() { return localStorage.getItem("automo.vision") || ""; },
  set vision(v: string) { localStorage.setItem("automo.vision", v); },
  get image() { return localStorage.getItem("automo.image") || ""; },
  set image(v: string) { localStorage.setItem("automo.image", v); },
  get approve() { return localStorage.getItem("automo.approve") === "1"; },
  set approve(v: boolean) { localStorage.setItem("automo.approve", v ? "1" : "0"); },
  get guardrails() { return localStorage.getItem("automo.guardrails") === "1"; },
  set guardrails(v: boolean) { localStorage.setItem("automo.guardrails", v ? "1" : "0"); },
  get instructions() { return localStorage.getItem("automo.instructions") || ""; },
  set instructions(v: string) { localStorage.setItem("automo.instructions", v); },
  get bridgeToken() { return localStorage.getItem("automo.bridgeToken") || "dev"; },
  set bridgeToken(v: string) { localStorage.setItem("automo.bridgeToken", v || "dev"); },
  // inference backend selection
  get provider() { return (localStorage.getItem("automo.provider") || "ollama") as "ollama" | "vllm" | "huggingface" | "browser" | "webllm"; },
  set provider(v: string) { localStorage.setItem("automo.provider", v); },
  get vllmUrl() { return localStorage.getItem("automo.vllmUrl") || "http://localhost:8000"; },
  set vllmUrl(v: string) { localStorage.setItem("automo.vllmUrl", v); },
  get hfToken() { return localStorage.getItem("automo.hfToken") || ""; },
  set hfToken(v: string) { localStorage.setItem("automo.hfToken", v); },
  // sandbox backend: "bridge" (real Unix on your machine via the daemon) or "inbrowser" (Pyodide +
  // just-bash + isomorphic-git in the page — zero install, sandboxed, can't touch real host files).
  get sandbox() { return (localStorage.getItem("automo.sandbox") || "bridge") as "bridge" | "inbrowser"; },
  set sandbox(v: string) { localStorage.setItem("automo.sandbox", v); },
  // autonomous mode: run queued/scheduled tasks on their own (opt-in; off by default).
  get autonomous() { return localStorage.getItem("automo.autonomous") === "1"; },
  set autonomous(v: boolean) { localStorage.setItem("automo.autonomous", v ? "1" : "0"); },
};

export const trimUrl = () => S.url.replace(/\/$/, "");
