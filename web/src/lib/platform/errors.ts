// Global error net. Per-call-site try/catch misses uncaught tool errors, dead workers, unhandled
// promise rejections, and browser interventions/deprecations (ReportingObserver). This routes all of them
// to the debug log and keeps the most recent failure so the agent context can surface it — a run that
// stalls on a crashed worker becomes visible rather than silent.
import { logEvent } from "../../store";

/* eslint-disable @typescript-eslint/no-explicit-any */
let lastError: { at: number; message: string } | null = null;
export function getLastError() { return lastError; }
function record(kind: string, message: string) {
  lastError = { at: Date.now(), message: `${kind}: ${message}`.slice(0, 300) };
  logEvent("error", lastError.message);
}

let installed = false;
export function initErrorHarness(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  window.addEventListener("error", (e: ErrorEvent) => {
    // resource-load errors have no `error`; skip those to avoid noise
    if (e.error || e.message) record("uncaught", e.error?.message ?? e.message);
  });

  window.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
    const r: any = e.reason;
    record("unhandled-rejection", r?.message ?? String(r));
  });

  // Browser-reported interventions/deprecations/crashes (e.g. a blocked request, a throttled feature).
  try {
    const RO = (globalThis as any).ReportingObserver;
    if (RO) new RO((reports: any[]) => {
      for (const rep of reports) record(rep.type ?? "report", rep.body?.message ?? rep.body?.reason ?? "reported");
    }, { buffered: true }).observe();
  } catch { /* unsupported */ }
}
