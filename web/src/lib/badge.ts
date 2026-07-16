// Badging API — surface the count of pending tool approvals on the installed PWA's app icon, so a
// run waiting on a decision is visible when the tab is backgrounded. Feature-detected, best-effort.
/* eslint-disable @typescript-eslint/no-explicit-any */
export function setBadge(count: number): void {
  try {
    const nav = navigator as any;
    if (count > 0) nav.setAppBadge?.(count);
    else nav.clearAppBadge?.();
  } catch { /* unsupported — no-op */ }
}
