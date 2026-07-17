// Durable substrate for the autonomous loop — goals, a task queue, an append-only event log, and
// serialized run state, all in IndexedDB so a closed/reloaded PWA resumes mid-task. The record is the
// source of truth and the loop is a pure function over it. Single-user, local-first, no server. The
// outer loop (loop.ts) and scheduler (scheduler.ts) build on this.
import { idbGet, idbSet } from "../../storage/idb";

// Status vocabulary aligns with the MCP Tasks protocol (@modelcontextprotocol/sdk TaskStatusSchema) so
// this durable queue matches the task-augmented MCP tool calls: `working` = running, `input_required` =
// blocked on approval (MCP's exact term), `completed`/`failed`/`cancelled` are terminal. `pending` is
// the only addition — MCP has no pre-start queued state (an MCP task exists only once work has started).
// See toMcpTask() below.
export type TaskStatus = "pending" | "working" | "input_required" | "completed" | "failed" | "cancelled";
const TERMINAL: TaskStatus[] = ["completed", "failed", "cancelled"];
export const isTerminal = (s: TaskStatus): boolean => TERMINAL.includes(s);

export interface TaskBudget { turns: number; toolCalls: number; wallMs: number }
export interface Task {
  id: string;
  goalId: string | null;
  prompt: string;               // what this run should do
  status: TaskStatus;
  runAfter: number;             // epoch ms — don't run before this (the schedule)
  cron?: string;                // if set, a repeating schedule: on success, runAfter re-arms to the next fire
  ttl?: number;                 // ms after createdAt to retain a non-terminal task before auto-cancel (MCP Task.ttl)
  deps: string[];               // task ids that must be `completed` first
  attempts: number;
  maxAttempts: number;
  budget: TaskBudget;
  allowlist: string[] | null;   // tool names this task may use (snapshot of creator's scope), null = all
  replaySafe: boolean;          // false once a side-effecting tool fired — don't blind-retry
  toolAllowlistLocked: boolean; // a scheduled task can't widen its own scope
  createdAt: number;
  updatedAt: number;
  note?: string;                // last status reason (e.g. "budget exhausted") == MCP Task.statusMessage
}
export interface Goal { id: string; spec: string; status: TaskStatus; createdAt: number }
export interface TaskEvent { t: number; taskId: string; kind: "run" | "tool" | "error" | "stop" | "schedule" | "critic"; msg: string }

// The MCP Task shape (subset of @modelcontextprotocol/sdk TaskSchema) the queue projects into when a
// task is exposed over the protocol. `pending` maps to `working` on the wire (MCP has no pre-start state).
export interface McpTask { taskId: string; status: Exclude<TaskStatus, "pending">; ttl: number | null; createdAt: string; lastUpdatedAt: string; statusMessage?: string }
export function toMcpTask(t: Task): McpTask {
  return {
    taskId: t.id,
    status: t.status === "pending" ? "working" : t.status,
    ttl: t.ttl ?? null,
    createdAt: new Date(t.createdAt).toISOString(),
    lastUpdatedAt: new Date(t.updatedAt).toISOString(),
    statusMessage: t.note,
  };
}

const K_TASKS = "auto.tasks", K_GOALS = "auto.goals", K_EVENTS = "auto.events";
const EVENT_CAP = 500;
const uid = () => "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const now = () => Date.now();

// ---- tasks ----
export async function getTasks(): Promise<Task[]> { return (await idbGet<Task[]>(K_TASKS)) || []; }
async function putTasks(t: Task[]) { await idbSet(K_TASKS, t); }

export async function enqueueTask(p: Partial<Task> & { prompt: string }): Promise<Task> {
  const task: Task = {
    id: p.id ?? uid(), goalId: p.goalId ?? null, prompt: p.prompt, status: p.status ?? "pending",
    runAfter: p.runAfter ?? now(), cron: p.cron, ttl: p.ttl, deps: p.deps ?? [], attempts: p.attempts ?? 0, maxAttempts: p.maxAttempts ?? 3,
    budget: p.budget ?? { turns: 24, toolCalls: 80, wallMs: 5 * 60_000 },
    allowlist: p.allowlist ?? null, replaySafe: p.replaySafe ?? true, toolAllowlistLocked: p.toolAllowlistLocked ?? false,
    createdAt: now(), updatedAt: now(), note: p.note,
  };
  const all = await getTasks();
  await putTasks([...all.filter((x) => x.id !== task.id), task]);
  return task;
}
export async function updateTask(id: string, patch: Partial<Task>): Promise<void> {
  const all = await getTasks();
  await putTasks(all.map((t) => (t.id === id ? { ...t, ...patch, updatedAt: now() } : t)));
}
export async function removeTask(id: string): Promise<void> {
  await putTasks((await getTasks()).filter((t) => t.id !== id));
  try { await idbSet("auto.thread:" + id, undefined); } catch { /* noop */ }
}

// The queue's core query: the earliest pending task whose schedule has arrived and whose deps are done.
export async function dequeueReady(at = now()): Promise<Task | null> {
  const all = await getTasks();
  const doneIds = new Set(all.filter((t) => t.status === "completed").map((t) => t.id));
  const ready = all
    .filter((t) => t.status === "pending" && t.runAfter <= at && t.deps.every((d) => doneIds.has(d)))
    .sort((a, b) => a.runAfter - b.runAfter);
  return ready[0] ?? null;
}
export async function hasDueWork(at = now()): Promise<boolean> { return (await dequeueReady(at)) !== null; }

// MCP tasks/cancel: mark a non-terminal task cancelled so the loop won't run it and the scheduler
// ignores it. Returns the resulting task (or null if unknown); terminal tasks are left as-is.
export async function cancelTask(id: string, reason = "cancelled"): Promise<Task | null> {
  const all = await getTasks();
  const t = all.find((x) => x.id === id);
  if (!t) return null;
  if (isTerminal(t.status)) return t;
  const next = { ...t, status: "cancelled" as const, note: reason, updatedAt: now() };
  await putTasks(all.map((x) => (x.id === id ? next : x)));
  return next;
}

// TTL sweep: auto-cancel non-terminal tasks that have outlived their ttl (MCP Task.ttl retention).
// Returns the count cancelled. Called opportunistically by the scheduler so stale work can't linger.
export async function expireStale(at = now()): Promise<number> {
  const all = await getTasks();
  let n = 0;
  const next = all.map((t) => {
    if (t.ttl && !isTerminal(t.status) && at > t.createdAt + t.ttl) { n++; return { ...t, status: "cancelled" as const, note: "ttl expired", updatedAt: at }; }
    return t;
  });
  if (n) await putTasks(next);
  return n;
}

// The earliest runAfter among pending tasks — the wall-clock instant the scheduler should next wake, or
// null when nothing is pending. Drives a precise timer instead of a poll: a task hours out costs no
// wakeups until its moment. Deps aren't factored in — a slightly-early wake just no-ops and re-arms.
export async function nextRunAfter(): Promise<number | null> {
  const pending = (await getTasks()).filter((t) => t.status === "pending");
  return pending.length ? Math.min(...pending.map((t) => t.runAfter)) : null;
}

// ---- MCP ServerTasks projection: the queue as MCP Tasks (tasks/list, tasks/get) ----
// Backs an MCP tasks surface so an external client can see/poll the autonomous work. Cancel is
// cancelTask() above (tasks/cancel). Kept here so the substrate owns the mapping, not the transport.
export async function listMcpTasks(): Promise<McpTask[]> { return (await getTasks()).map(toMcpTask); }
export async function getMcpTask(id: string): Promise<McpTask | null> {
  const t = (await getTasks()).find((x) => x.id === id);
  return t ? toMcpTask(t) : null;
}

// ---- serialized run state (resume across reloads) ----
export async function saveThread(taskId: string, runState: unknown): Promise<void> { await idbSet("auto.thread:" + taskId, runState); }
export async function loadThread<T = unknown>(taskId: string): Promise<T | undefined> { return idbGet<T>("auto.thread:" + taskId); }

// ---- goals ----
export async function listGoals(): Promise<Goal[]> { return (await idbGet<Goal[]>(K_GOALS)) || []; }
export async function saveGoal(g: Partial<Goal> & { spec: string }): Promise<Goal> {
  const goal: Goal = { id: g.id ?? "g" + uid(), spec: g.spec, status: g.status ?? "pending", createdAt: now() };
  const all = await listGoals();
  await idbSet(K_GOALS, [...all.filter((x) => x.id !== goal.id), goal]);
  return goal;
}

// ---- append-only event log (capped ring) ----
export async function appendEvent(taskId: string, kind: TaskEvent["kind"], msg: string): Promise<void> {
  const all = (await idbGet<TaskEvent[]>(K_EVENTS)) || [];
  await idbSet(K_EVENTS, [...all.slice(-(EVENT_CAP - 1)), { t: now(), taskId, kind, msg: msg.slice(0, 500) }]);
}
export async function getEvents(taskId?: string): Promise<TaskEvent[]> {
  const all = (await idbGet<TaskEvent[]>(K_EVENTS)) || [];
  return taskId ? all.filter((e) => e.taskId === taskId) : all;
}
