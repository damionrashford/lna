// Page Lifecycle durability. Chrome freezes and discards backgrounded tabs to reclaim memory, and a run in
// flight would otherwise vanish. On freeze/pagehide (both fire before the tab is torn down) we call
// registered flushers to persist last-moment state; on reload, wasDiscarded() tells callers the tab was
// reclaimed. The autonomous queue is already durable in IndexedDB — see resetOrphanedTasks in the loop
// substrate, which re-arms a task interrupted by a discard.
import { logEvent } from "../../store";

type Flusher = () => void;
const flushers = new Set<Flusher>();
export function registerFlusher(f: Flusher): () => void { flushers.add(f); return () => { flushers.delete(f); }; }
export function wasDiscarded(): boolean { return typeof document !== "undefined" && (document as any).wasDiscarded === true; }

let installed = false;
export function initLifecycle(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  const flush = () => { for (const f of flushers) { try { f(); } catch { /* best-effort */ } } };
  document.addEventListener("freeze", flush);   // Page Lifecycle: tab about to be frozen
  window.addEventListener("pagehide", flush);   // hidden/unloading — fires reliably (unlike beforeunload)
  if (wasDiscarded()) logEvent("info", "tab was discarded and reloaded — resuming");
}
