// Scheduler for the autonomous task queue. The browser has no reliable background cron (Periodic
// Background Sync is Chromium-only, install-gated, and ~12h-throttled), so the IndexedDB `runAfter`
// timestamp is the source of truth and the queue is drained on every available trigger: an interval
// while visible, on wake (visibility/focus/idle), and a best-effort service-worker periodicsync/sync
// that wakes an open client to pump. The agent only runs in the page (it needs the model and DOM), so
// a fully-closed tab can't run tasks; the SW path only widens the window a backgrounded tab gets poked.
import { tick } from "./loop";
import { hasDueWork, nextRunAfter, expireStale, resetOrphanedTasks } from "./tasks";
import { logEvent } from "../../../store";
import { shouldThrottle, onEnvironmentChange } from "../../platform/environment";

/* eslint-disable @typescript-eslint/no-explicit-any */
let timer: any = null;
let running = false;
const SYNC_TAG = "automo-drain"; // shared with the SW handlers (build.ts) and the periodicSync registration

// Timer bounds. Sleep until the next task's runAfter, clamped: a floor so an overdue task can't spin
// the loop, a visible ceiling so long timers (unreliable across OS sleep) get re-checked, and a larger
// hidden ceiling since a backgrounded tab shouldn't churn — a wake event re-arms it anyway.
const MIN_MS = 1_000;
const CEIL_VISIBLE_MS = 60_000;
const CEIL_HIDDEN_MS = 5 * 60_000;
const isHidden = () => typeof document !== "undefined" && document.visibilityState !== "visible";

async function pump(): Promise<void> {
  if (isHidden()) return;       // only run the agent while foregrounded (it needs the page)
  if (shouldThrottle()) return; // ease off a throttling device (thermal pressure or low battery); a later env change re-arms
  try { await expireStale(); if (await hasDueWork()) await tick(); } catch (e: any) { logEvent("warn", "scheduler pump: " + (e?.message ?? e)); }
}

// Arm a single precise timer: delay = (earliest runAfter) − now, clamped. Driven by the wall clock
// (Date.now, via nextRunAfter) so the timer fires at the due moment rather than on a fixed cadence, and
// only up to the safety ceiling when nothing is queued.
async function arm(): Promise<void> {
  if (!running) return;
  if (timer) { clearTimeout(timer); timer = null; }
  const next = await nextRunAfter();
  const ceil = isHidden() ? CEIL_HIDDEN_MS : CEIL_VISIBLE_MS;
  const delay = next === null ? ceil : Math.min(Math.max(next - Date.now(), MIN_MS), ceil);
  timer = setTimeout(cycle, delay);
}

async function cycle(): Promise<void> { await pump(); await arm(); }

// External wake (visibility/focus/idle/SW message): drain and re-arm off the fresh clock. This is what
// makes a task that came due while the machine slept run the instant the tab is refocused.
function wake(): void { void cycle(); }

// The SW can't run the agent, so it posts an "automo-drain" message to wake a client, which drains.
function onSwMessage(e: MessageEvent): void { if (e.data?.type === SYNC_TAG) wake(); }

async function registerBackgroundDrain(): Promise<void> {
  const sw = (navigator as any)?.serviceWorker;
  if (!sw) return;
  sw.addEventListener("message", onSwMessage);
  try {
    const reg: any = await sw.ready;
    // Periodic Background Sync — Chromium + installed PWA + granted permission only; throws/ignored otherwise.
    if (reg.periodicSync) await reg.periodicSync.register(SYNC_TAG, { minInterval: 12 * 60 * 60_000 });
  } catch { /* unsupported/ungranted — foreground drain remains the primary path */ }
}

let offEnv: (() => void) | null = null;
export function startScheduler(): void {
  if (running) return;
  running = true;
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", wake);
  if (typeof window !== "undefined") window.addEventListener("focus", wake);
  offEnv = onEnvironmentChange(wake); // re-arm when connectivity/pressure/battery changes (throttle may lift)
  void resetOrphanedTasks().then((n) => { if (n) logEvent("info", `re-armed ${n} task(s) interrupted by a tab discard`); });
  void registerBackgroundDrain();
  wake(); // drain anything already due, then arm the first precise timer
  logEvent("info", "autonomous scheduler started (precise wall-clock timer + best-effort SW wake)");
}

export function stopScheduler(): void {
  running = false;
  if (timer) { clearTimeout(timer); timer = null; }
  if (typeof document !== "undefined") document.removeEventListener("visibilitychange", wake);
  if (typeof window !== "undefined") window.removeEventListener("focus", wake);
  offEnv?.(); offEnv = null;
  const sw = (navigator as any)?.serviceWorker;
  if (sw) sw.removeEventListener("message", onSwMessage);
}
