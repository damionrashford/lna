// The outer autonomous loop, structured as a reducer rather than a daemon. `tick(now)` is one
// idempotent step: if this tab is the leader and a task is due, run it to completion (or blocked/failed)
// through the same provider, agent, and sandbox the chat uses. Safe to call from any trigger (timer,
// visibility, scheduler); one task per tick so it never hogs the main thread. The SDK's run() is the
// inner (ReAct) loop, wrapped here rather than reimplemented.
import { run, RunState, OutputGuardrailTripwireTriggered } from "@openai/agents";
import { S, getState, logEvent } from "../../../store";
import { runAsLeader } from "../../platform/locks";
import { installModelProvider } from "../model/model";
import { buildContext } from "../context/run-context";
import { toolOutputTrimmer } from "../context/trim";
import { buildAgent, ensureSandbox } from "../../agent";
import { dequeueReady, updateTask, appendEvent, getTasks, saveThread, loadThread, type Task } from "./tasks";
import { isLooping, clearLoopGuard } from "./loopguard";
import { criticGuardrail } from "./critic";
import { nextCronRun } from "./cron";
import { setCurrentTaskId } from "./current";
import { yieldToInput } from "../../platform/perf";
import { notifyIfHidden } from "../../platform/notify";

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
  await yieldToInput(); // let the user's typing/scrolling go first before a heavy background run
  await updateTask(task.id, { status: "working" });
  await appendEvent(task.id, "run", task.prompt.slice(0, 160));
  await executeRun(task, task.prompt);
}

// Resume a task that blocked on a tool approval. The serialized RunState was persisted at block time, so
// this rehydrates the exact in-flight run, applies the human decision to every pending approval, and
// continues from where it stopped without redoing work. `approve=false` rejects the calls instead.
export async function resumeTask(taskId: string, approve: boolean): Promise<void> {
  const task = (await getTasks()).find((t) => t.id === taskId);
  if (!task || task.status !== "input_required") return;
  const saved = await loadThread<string>(taskId);
  if (typeof saved !== "string") { logEvent("warn", `resume ${taskId}: no saved RunState`); return; }
  installModelProvider(S.model);
  const agent = buildAgent(S.model);
  const state = await RunState.fromString(agent as any, saved);
  for (const it of state.getInterruptions()) approve ? state.approve(it) : state.reject(it);
  await updateTask(task.id, { status: "working", note: approve ? "resumed: approved" : "resumed: rejected" });
  await appendEvent(task.id, "run", `resume (${approve ? "approved" : "rejected"})`);
  await executeRun(task, state);
}

// The shared run → outcome path. `input` is either a prompt (fresh) or a RunState (resume), and the
// interruption-persist, loop-guard, critic-tripwire, done, and error-retry outcomes are handled the
// same for both.
async function executeRun(task: Task, input: string | RunState<any, any>): Promise<void> {
  setCurrentTaskId(task.id); // lets a task-augmented MCP tool call attribute progress back to this task
  try {
    const model = S.model;
    installModelProvider(model);
    const agent = buildAgent(model);
    const session = await ensureSandbox();
    const result: any = await run(agent, input as any, {
      sandbox: { session },
      context: buildContext(session, getState().sessionId),
      maxTurns: task.budget.turns,
      callModelInputFilter: toolOutputTrimmer(),
      // Critic gate as a per-run output guardrail: judges the final output against this task's goal and
      // trips a tripwire (caught below → retry) when the goal isn't met. Run-level, not agent-level, so
      // it only governs autonomous tasks; interactive chat replies are never gated on goal-completion.
      outputGuardrails: [criticGuardrail(task.prompt)],
    } as any);

    if (result.interruptions?.length) {
      // A high-stakes tool needs approval: persist the exact RunState so resumeTask() can continue it
      // after a human decision (survives reload), then park the task.
      await saveThread(task.id, result.state.toString());
      await updateTask(task.id, { status: "input_required", note: "awaiting approval" });
      await appendEvent(task.id, "stop", "blocked on approval");
      notifyIfHidden("AUTOMO — approval needed", task.prompt.slice(0, 100));
      return;
    }
    const out = typeof result.finalOutput === "string" ? result.finalOutput : JSON.stringify(result.finalOutput ?? "");

    // Loop-guard: a task that keeps producing the same output across attempts is stuck; fail it fast
    // instead of burning the remaining retry budget on identical work. Skipped for recurring tasks,
    // where identical output across occurrences (e.g. a daily "all clear" check) is expected.
    if (!task.cron && isLooping(task.id, out)) {
      await updateTask(task.id, { status: "failed", note: "loop detected: identical result repeated" });
      await appendEvent(task.id, "stop", "failed: looping");
      logEvent("warn", `autonomous task ${task.id} failed: looping`);
      return;
    }

    clearLoopGuard(task.id);
    await appendEvent(task.id, "critic", "pass");
    // Recurring task: re-arm to the next fire instead of terminating; one durable record keeps repeating.
    if (task.cron) {
      const next = nextCronRun(task.cron);
      if (next) {
        await updateTask(task.id, { status: "pending", attempts: 0, runAfter: next, note: "recurring; last ok: " + out.slice(0, 120) });
        await appendEvent(task.id, "schedule", "recurring → next " + new Date(next).toISOString());
        logEvent("info", `recurring task ${task.id} ran; next ${new Date(next).toISOString()}`);
        return;
      }
    }
    await updateTask(task.id, { status: "completed", note: out.slice(0, 200) });
    await appendEvent(task.id, "stop", "done");
    logEvent("info", `autonomous task ${task.id} done`);
    notifyIfHidden("AUTOMO — task done", task.prompt.slice(0, 100));
  } catch (e: any) {
    // Critic tripwire = the output didn't meet the goal → treat as a retry, not a crash.
    if (e instanceof OutputGuardrailTripwireTriggered) {
      const reason = String(e.result?.output?.outputInfo ?? "goal not met").slice(0, 160);
      const attempts = task.attempts + 1;
      await appendEvent(task.id, "critic", "fail: " + reason);
      if (attempts < task.maxAttempts) {
        await updateTask(task.id, { status: "pending", attempts, runAfter: Date.now() + backoff(attempts), note: "critic: " + reason.slice(0, 120) });
        logEvent("info", `autonomous task ${task.id} rejected by critic (attempt ${attempts}): ${reason}`);
      } else {
        await updateTask(task.id, { status: "failed", attempts, note: "critic rejected: " + reason });
        logEvent("warn", `autonomous task ${task.id} failed critic after ${attempts} attempts`);
      }
      return;
    }
    const msg = e?.message ?? String(e);
    await appendEvent(task.id, "error", msg);
    const attempts = task.attempts + 1;
    // replay-safety: a turn that fired a side-effecting tool ideally shouldn't be blind-retried (tracked
    // via task.replaySafe). Current path is a plain backoff retry, then give up.
    if (attempts < task.maxAttempts) {
      await updateTask(task.id, { status: "pending", attempts, runAfter: Date.now() + backoff(attempts), note: "retry: " + msg.slice(0, 80) });
    } else {
      await updateTask(task.id, { status: "failed", attempts, note: msg.slice(0, 200) });
    }
    logEvent("warn", `autonomous task ${task.id} failed (attempt ${attempts}): ${msg}`);
  } finally {
    setCurrentTaskId(null);
  }
}
