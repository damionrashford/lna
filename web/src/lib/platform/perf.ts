// Native performance instrumentation. A PerformanceObserver on longtask entries surfaces main-thread jank
// (blocks that would stall input) in the debug log — complementing the SDK trace spans with real
// responsiveness data. The mark/measure helpers give precise per-run latency without hand-rolled timers.
import { logEvent } from "../../store";

const JANK_MS = 200; // report only genuinely disruptive blocks, not every 50ms longtask

let installed = false;
export function initPerf(): void {
  if (installed || typeof PerformanceObserver === "undefined") return;
  installed = true;
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (e.duration >= JANK_MS) logEvent("warn", `main thread blocked ${Math.round(e.duration)}ms (long task)`);
    }).observe({ type: "longtask", buffered: true } as any);
  } catch { /* longtask entry type unsupported */ }
}

export function mark(name: string): void { try { performance.mark(name); } catch { /* unsupported */ } }
export function measure(name: string, startMark: string): number {
  try { return performance.measure(name, startMark).duration; } catch { return 0; }
}

// Yield the main thread when the user has pending input, so heavy background work (an autonomous run)
// doesn't stall typing/scrolling. Uses scheduler.yield() where available, else an isInputPending-gated
// macrotask, else a no-op.
export async function yieldToInput(): Promise<void> {
  const s = (globalThis as any).scheduler;
  if (typeof s?.yield === "function") { try { await s.yield(); return; } catch { /* fall through */ } }
  if ((navigator as any).scheduling?.isInputPending?.()) await new Promise((r) => setTimeout(r, 0));
}
