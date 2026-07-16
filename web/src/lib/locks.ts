// Web Locks — ensure only one tab drives the shared bridge sandbox at a time, so two tabs can't
// stomp the same on-disk workspace. We hold a named lock for the lifetime of this tab's sandbox
// session; a second tab that can't get it (ifAvailable) is told to use the tab that owns it.
// Feature-detected: where Web Locks is unavailable we don't block (single-tab assumption).
/* eslint-disable @typescript-eslint/no-explicit-any */
const LOCK = "automo-sandbox";
let release: (() => void) | null = null;

export async function acquireSandboxLock(): Promise<boolean> {
  if (!(navigator as any).locks) return true;
  if (release) return true; // already held by this tab
  return new Promise<boolean>((resolve) => {
    (navigator as any).locks
      .request(LOCK, { ifAvailable: true }, (lock: any) => {
        if (!lock) { resolve(false); return; } // another tab holds it
        resolve(true);
        return new Promise<void>((rel) => { release = rel; }); // hold until releaseSandboxLock()
      })
      .catch(() => resolve(true)); // don't hard-block on lock-manager errors
  });
}

export function releaseSandboxLock(): void {
  release?.();
  release = null;
}
