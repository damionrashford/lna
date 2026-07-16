// Tiny external store: a single immutable-at-top-level state object that React
// subscribes to via useSyncExternalStore. Action modules mutate through set().
import { useSyncExternalStore } from "react";

export type Cap = { dot: string; text: string };

export type ThreadItem =
  | { id: string; kind: "msg"; role: "user" | "assistant"; text: string; image?: string; err?: boolean; thinking?: boolean; streaming?: boolean; genImage?: string; genCaption?: string }
  | { id: string; kind: "tool"; name: string; argsStr: string; result?: string }
  | { id: string; kind: "approve"; name: string; argsStr: string; onDecision: (ok: boolean) => void };

export type McpView = { label: string; transport: string; connected: boolean; error: string | null; tools: number };

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
  get budget() { return +(localStorage.getItem("automo.budget") || 16000); },
  set budget(v: number) { localStorage.setItem("automo.budget", String(v)); },
  get compactAt() { return +(localStorage.getItem("automo.compactAt") || 0); },
  set compactAt(v: number) { localStorage.setItem("automo.compactAt", String(v)); },
};

export const trimUrl = () => S.url.replace(/\/$/, "");
