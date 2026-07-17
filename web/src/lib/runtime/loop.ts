// The outer autonomous loop — a reducer, not a daemon. `tick(now)` is one idempotent step: if this tab
// is the leader and a task is due, run it to completion (or blocked/failed) through the SAME provider,
// agent, and sandbox the chat uses. Safe to call from any trigger (timer, visibility, scheduler); one
// task per tick so it never hogs the main thread. The SDK's run() is the INNER (ReAct) loop — we wrap
// it, we don't rebuild it.
//
// This slice does dequeue → run → done/blocked/failed(+backoff retry). Follow-up slices add the critic
// gate, loop-guard, RunState persist/resume, and the until-dry / no-progress stop conditions.
import { run } from "@openai/agents";
import { S, getState, logEvent } from "../../store";
import { runAsLeader } from "../platform/locks";
import { installModelProvider } from "./model";
import { buildContext } from "./context";
import { toolOutputTrimmer } from "./trim";
import { buildAgent, ensureSandbox } from "../agent";
import { dequeueReady, updateTask, appendEvent, type Task } from "./tasks";

/* eslint-disable @typescript-eslint/no-explicit-any */
let ticking = false;
const backoff = (n: number) => Math.min(60_000, 1000 * 2 ** n); // 2s,4s,8s… capped at 60s

export async function tick(at = Date.now()): Promise<"ran" | "idle" | "not-leader" | "busy"> {
  if (ticking) return "busy"; // never re-enter (one task at a time on the main thread)
  ticking = true;
  try {
    const r = await runAsLeader(async () => {
      const task = await dequeueReady(at);
      if (!task) return "idle" as const;
      await runTask(task);
      return "ran" as const;
    });
    return r ?? "not-leader";
  } finally { ticking = false; }
}

async function runTask(task: Task): Promise<void> {
  await updateTask(task.id, { status: "active" });
  await appendEvent(task.id, "run", task.prompt.slice(0, 160));
  try {
    const model = S.model;
    installModelProvider(model);
    const agent = buildAgent(model);
    const session = await ensureSandbox();
    const result: any = await run(agent, task.prompt, {
      sandbox: { session },
      context: buildContext(session, getState().sessionId),
      maxTurns: task.budget.turns,
      callModelInputFilter: toolOutputTrimmer(),
    } as any);

    if (result.interruptions?.length) {
      // a high-stakes tool needs approval — park the task (resume flow lands in a later slice)
      await updateTask(task.id, { status: "blocked", note: "awaiting approval" });
      await appendEvent(task.id, "stop", "blocked on approval");
      return;
    }
    const out = typeof result.finalOutput === "string" ? result.finalOutput : JSON.stringify(result.finalOutput ?? "");
    await updateTask(task.id, { status: "done", note: out.slice(0, 200) });
    await appendEvent(task.id, "stop", "done");
    logEvent("info", `autonomous task ${task.id} done`);
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    await appendEvent(task.id, "error", msg);
    const attempts = task.attempts + 1;
    // replay-safety: once a turn fired a side-effecting tool we don't blind-retry (a later slice tracks
    // this precisely); for now a plain backoff retry, then give up.
    if (attempts < task.maxAttempts) {
      await updateTask(task.id, { status: "pending", attempts, runAfter: Date.now() + backoff(attempts), note: "retry: " + msg.slice(0, 80) });
    } else {
      await updateTask(task.id, { status: "failed", attempts, note: msg.slice(0, 200) });
    }
    logEvent("warn", `autonomous task ${task.id} failed (attempt ${attempts}): ${msg}`);
  }
}
