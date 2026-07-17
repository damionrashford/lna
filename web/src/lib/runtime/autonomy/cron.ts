// Recurrence math for the task queue. The scheduler fires one-shot tasks off their runAfter timestamp;
// this computes the next runAfter from a cron expression for repeating schedules. Only cron-schedule's
// next-date calculator is used — its bundled in-memory schedulers wouldn't survive a reload, so the
// durable IndexedDB queue stays authoritative. Single import site for the dependency.
import { parseCronExpression } from "cron-schedule";

export function isValidCron(expr: string): boolean {
  try { parseCronExpression(expr); return true; } catch { return false; }
}

// Epoch-ms of the next time `expr` fires after `from`, or null if the expression is invalid.
export function nextCronRun(expr: string, from: Date = new Date()): number | null {
  try { return parseCronExpression(expr).getNextDate(from).getTime(); } catch { return null; }
}
