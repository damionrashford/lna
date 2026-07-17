// Web Locks — ensure only one tab drives the shared bridge sandbox at a time, so two tabs can't stomp
// the same on-disk workspace. A named lock is held for the lifetime of this tab's sandbox session; a
// second tab that can't acquire it (ifAvailable) is told to use the owning tab. Feature-detected: where
// Web Locks is unavailable, don't block (single-tab assumption).
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

// Run `fn` only if this tab can grab the loop-leader lock (held just for fn's duration). A second tab
// that can't get it skips — so the autonomous task queue is drained by exactly one tab at a time.
// Returns fn's result, or null when another tab is the leader.
export async function runAsLeader<T>(fn: () => Promise<T>): Promise<T | null> {
  if (!(navigator as any).locks) return fn(); // single-tab assumption without Web Locks
  return (navigator as any).locks.request("automo-loop-leader", { ifAvailable: true }, async (lock: any) => {
    if (!lock) return null; // another tab is the leader this tick
    return fn();
  }).catch(() => null);
}
