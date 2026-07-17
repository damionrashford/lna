// Scheduler — the "opportunistic drain" half of proactive execution. The browser gives NO reliable
// background cron (Periodic Background Sync is Chromium-only, install-gated, ~12h-throttled), so the
// rule is: the IndexedDB `runAfter` timestamp is the source of truth, and we drain the queue on every
// trigger we can get — an interval while visible, and immediately on wake (visibility/focus/idle).
// Background (service-worker sync/periodicsync) is a later slice; foreground is the primary path.
import { tick } from "./loop";
import { hasDueWork } from "./tasks";
import { logEvent } from "../../store";

let timer: any = null;
const INTERVAL_MS = 15_000;

async function pump(): Promise<void> {
  if (typeof document !== "undefined" && document.visibilityState !== "visible") return; // only while foregrounded
  try { if (await hasDueWork()) await tick(); } catch (e: any) { logEvent("warn", "scheduler pump: " + (e?.message ?? e)); }
}

export function startScheduler(): void {
  if (timer) return;
  timer = setInterval(pump, INTERVAL_MS);
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", pump);
  if (typeof window !== "undefined") window.addEventListener("focus", pump);
  const idle = (globalThis as any).requestIdleCallback ?? ((cb: any) => setTimeout(cb, 1000));
  idle(pump); // catch anything already due on start
  logEvent("info", "autonomous scheduler started (foreground drain)");
}

export function stopScheduler(): void {
  if (timer) { clearInterval(timer); timer = null; }
  if (typeof document !== "undefined") document.removeEventListener("visibilitychange", pump);
  if (typeof window !== "undefined") window.removeEventListener("focus", pump);
}
