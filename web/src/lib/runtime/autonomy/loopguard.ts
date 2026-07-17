// Loop detection for the outer autonomous loop. A stuck task retries and produces the SAME result every
// time — a burned budget with no progress. We fingerprint each attempt's output and, if the same
// fingerprint repeats, declare the task looping so the loop can fail it fast instead of retrying to zero.
//
// Volatile-ID stripping is the crux: two identical runs still differ by timestamps, uuids, hex ids, and
// run counters, so a raw hash never matches. We normalize those out first, then hash, so "same work,
// different nonce" collapses to one fingerprint.

// Replace the things that legitimately change run-to-run with a stable placeholder.
function stripVolatile(s: string): string {
  return s
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>") // uuids
    .replace(/\b[0-9a-f]{16,}\b/gi, "<hex>")                                                  // long hex ids
    .replace(/\b\d{10,13}\b/g, "<ts>")                                                        // epoch ms/s
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?/g, "<iso>") // ISO dates
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// Small, fast, stable string hash (FNV-1a, 32-bit) rendered hex — good enough to compare run outputs.
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
}

export function fingerprint(output: string): string {
  return fnv1a(stripVolatile(output ?? ""));
}

// Tracks recent fingerprints per task id (in-memory, session-scoped — loop detection is a within-session
// safety net, not durable state). record() returns how many times this exact output has now been seen.
const seen = new Map<string, string[]>();
const WINDOW = 4; // remember the last few attempts per task

// Record an attempt's output; returns the repeat count of this fingerprint within the window.
export function recordAttempt(taskId: string, output: string): number {
  const fp = fingerprint(output);
  const arr = seen.get(taskId) ?? [];
  arr.push(fp);
  while (arr.length > WINDOW) arr.shift();
  seen.set(taskId, arr);
  return arr.filter((x) => x === fp).length;
}

// True once the same output has repeated at least `threshold` times — the task is going in circles.
export function isLooping(taskId: string, output: string, threshold = 2): boolean {
  return recordAttempt(taskId, output) >= threshold;
}

export function clearLoopGuard(taskId: string): void { seen.delete(taskId); }
