// Screen Wake Lock — keep the machine from sleeping during long agent runs. Feature-detected and
// best-effort: the request is rejected under battery saver or when the tab is hidden, and the OS
// auto-releases when the tab backgrounds, so re-acquire on return to foreground while still busy.
/* eslint-disable @typescript-eslint/no-explicit-any */
let sentinel: any = null;
let wanted = false;

export async function acquireWakeLock(): Promise<void> {
  wanted = true;
  try {
    if (sentinel || !(navigator as any).wakeLock) return;
    sentinel = await (navigator as any).wakeLock.request("screen");
    sentinel.addEventListener?.("release", () => { sentinel = null; });
  } catch { /* denied — non-fatal */ }
}

export async function releaseWakeLock(): Promise<void> {
  wanted = false;
  try { await sentinel?.release?.(); } catch { /* noop */ }
  sentinel = null;
}

// Re-acquire when the tab returns to the foreground if a run is still in flight.
export function initWakeLock(): void {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && wanted && !sentinel) acquireWakeLock();
  });
}
