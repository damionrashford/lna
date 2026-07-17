// Durable substrate for the autonomous loop — goals, a task queue, an append-only event log, and
// serialized run state, all in IndexedDB so a closed/reloaded PWA resumes mid-task. This is the
// "stateless reducer" store: the record IS the truth, the loop is a pure function over it. No server,
// single-user, local-first. The outer loop (loop.ts) and scheduler (scheduler.ts) build on this.
import { idbGet, idbSet } from "../storage/idb";

export type TaskStatus = "pending" | "active" | "blocked" | "done" | "failed";
export interface TaskBudget { turns: number; toolCalls: number; wallMs: number }
export interface Task {
  id: string;
  goalId: string | null;
  prompt: string;               // what this run should do
  status: TaskStatus;
  runAfter: number;             // epoch ms — don't run before this (the schedule)
  deps: string[];               // task ids that must be `done` first
  attempts: number;
  maxAttempts: number;
  budget: TaskBudget;
  allowlist: string[] | null;   // tool names this task may use (snapshot of creator's scope), null = all
  replaySafe: boolean;          // false once a side-effecting tool fired — don't blind-retry
  toolAllowlistLocked: boolean; // a scheduled task can't widen its own scope
  createdAt: number;
  updatedAt: number;
  note?: string;                // last status reason (e.g. "budget exhausted")
}
export interface Goal { id: string; spec: string; status: "pending" | "active" | "blocked" | "done" | "failed"; createdAt: number }
export interface TaskEvent { t: number; taskId: string; kind: "run" | "tool" | "error" | "stop" | "schedule" | "critic"; msg: string }

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
    runAfter: p.runAfter ?? now(), deps: p.deps ?? [], attempts: p.attempts ?? 0, maxAttempts: p.maxAttempts ?? 3,
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
  const doneIds = new Set(all.filter((t) => t.status === "done").map((t) => t.id));
  const ready = all
    .filter((t) => t.status === "pending" && t.runAfter <= at && t.deps.every((d) => doneIds.has(d)))
    .sort((a, b) => a.runAfter - b.runAfter);
  return ready[0] ?? null;
}
export async function hasDueWork(at = now()): Promise<boolean> { return (await dequeueReady(at)) !== null; }

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
