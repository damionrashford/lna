// Recurrence math for the task queue. The scheduler fires one-shot tasks off their runAfter timestamp;
// this adds repeating schedules by computing the NEXT runAfter from a cron expression. cron-schedule is a
// zero-dependency parser — we use only its next-date calculator and keep our own durable IndexedDB queue
// (its bundled schedulers are in-memory and wouldn't survive a reload). One import site for the dep.
import { parseCronExpression } from "cron-schedule";

export function isValidCron(expr: string): boolean {
  try { parseCronExpression(expr); return true; } catch { return false; }
}

// Epoch-ms of the next time `expr` fires after `from`, or null if the expression is invalid.
export function nextCronRun(expr: string, from: Date = new Date()): number | null {
  try { return parseCronExpression(expr).getNextDate(from).getTime(); } catch { return null; }
}
