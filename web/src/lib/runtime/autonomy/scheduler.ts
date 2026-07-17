// Scheduler — the "opportunistic drain" half of proactive execution. The browser gives NO reliable
// background cron (Periodic Background Sync is Chromium-only, install-gated, ~12h-throttled), so the
// rule is: the IndexedDB `runAfter` timestamp is the source of truth, and we drain the queue on every
// trigger we can get — an interval while visible, immediately on wake (visibility/focus/idle), AND a
// best-effort background nudge: the service worker's periodicsync/sync wakes any open client to pump.
// The agent itself only runs in the page (it needs the model + DOM), so a fully-closed tab still can't
// run tasks — the SW path just widens the window in which a backgrounded/hidden tab gets poked.
import { tick } from "./loop";
import { hasDueWork, nextRunAfter, expireStale } from "./tasks";
import { logEvent } from "../../../store";

/* eslint-disable @typescript-eslint/no-explicit-any */
let timer: any = null;
let running = false;
const SYNC_TAG = "automo-drain"; // shared with the SW handlers (build.ts) and the periodicSync registration

// Timer bounds. We sleep exactly until the next task's runAfter, but clamp: a floor so an overdue task
// can't spin the loop, a visible ceiling so long timers (unreliable across OS sleep) get re-checked, and
// a larger hidden ceiling since a backgrounded tab shouldn't churn — a wake event will re-arm it anyway.
const MIN_MS = 1_000;
const CEIL_VISIBLE_MS = 60_000;
const CEIL_HIDDEN_MS = 5 * 60_000;
const isHidden = () => typeof document !== "undefined" && document.visibilityState !== "visible";

async function pump(): Promise<void> {
  if (isHidden()) return; // only run the agent while foregrounded (it needs the page)
  try { await expireStale(); if (await hasDueWork()) await tick(); } catch (e: any) { logEvent("warn", "scheduler pump: " + (e?.message ?? e)); }
}

// Arm a single precise timer: delay = (earliest runAfter) − now, clamped. Driven by the wall clock
// (Date.now, via nextRunAfter) so we wake AT the due moment, not on a fixed cadence — and not at all when
// nothing is queued past the safety ceiling.
async function arm(): Promise<void> {
  if (!running) return;
  if (timer) { clearTimeout(timer); timer = null; }
  const next = await nextRunAfter();
  const ceil = isHidden() ? CEIL_HIDDEN_MS : CEIL_VISIBLE_MS;
  const delay = next === null ? ceil : Math.min(Math.max(next - Date.now(), MIN_MS), ceil);
  timer = setTimeout(cycle, delay);
}

// One scheduler cycle: drain what's due, then re-arm off the new earliest due time.
async function cycle(): Promise<void> { await pump(); await arm(); }

// External wake (visibility/focus/idle/SW message): drain now and re-arm immediately off the fresh clock —
// this is what makes a task that came due while the machine slept run the instant the tab is refocused.
function wake(): void { void cycle(); }

// The SW can't run the agent, so it posts an "automo-drain" message to wake a client; we drain on it.
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

export function startScheduler(): void {
  if (running) return;
  running = true;
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", wake);
  if (typeof window !== "undefined") window.addEventListener("focus", wake);
  void registerBackgroundDrain();
  wake(); // drain anything already due, then arm the first precise timer
  logEvent("info", "autonomous scheduler started (precise wall-clock timer + best-effort SW wake)");
}

export function stopScheduler(): void {
  running = false;
  if (timer) { clearTimeout(timer); timer = null; }
  if (typeof document !== "undefined") document.removeEventListener("visibilitychange", wake);
  if (typeof window !== "undefined") window.removeEventListener("focus", wake);
  const sw = (navigator as any)?.serviceWorker;
  if (sw) sw.removeEventListener("message", onSwMessage);
}
