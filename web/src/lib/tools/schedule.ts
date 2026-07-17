// schedule_task — lets the agent queue future work for itself into the durable task substrate
// (tasks.ts, IndexedDB). The scheduler (scheduler.ts) drains due tasks when autonomous mode is on and
// the tab is visible. Two safety invariants ride along:
//   1. Allowlist snapshot + lock: a scheduled task may only use the tools named here, and it can't widen
//      that scope later (toolAllowlistLocked). Omit `tools` only for a fully-trusted follow-up.
//   2. Runaway guard: a hard cap on pending scheduled tasks and a bounded delay window, so a model that
//      loops on "schedule another one" can't flood the queue or schedule work years out.
// Standard @openai/agents function tool. No plan/model magic — it just writes a durable record.
import { tool } from "@openai/agents";
import { z } from "zod";
import { enqueueTask, appendEvent, getTasks } from "../runtime/autonomy/tasks";
import { isValidCron, nextCronRun } from "../runtime/autonomy/cron";
import { S } from "../../store";

const MAX_PENDING = 50;                    // don't let self-scheduling flood the queue
const MAX_DELAY_MS = 30 * 24 * 60 * 60_000; // 30 days — the browser can't reliably wake past that anyway

export const scheduleTool = tool({
  name: "schedule_task",
  description:
    "Queue a task to run later, on its own, in autonomous mode. Use for follow-ups, deferred work, or a recurring check the user asked for. Provide a concrete `prompt` describing exactly what that later run should do (it starts fresh with no memory of this conversation). `delayMinutes` is how long to wait before it becomes eligible. `tools` restricts which tools that run may use — it is snapshotted and locked, so the scheduled task cannot exceed it; omit it only for a fully-trusted follow-up. Note: the browser has no guaranteed background timer — a task runs on the next visible, idle moment after its delay, not exactly on time.",
  parameters: z.object({
    prompt: z.string().min(1).describe("self-contained instructions for the future run"),
    delayMinutes: z.number().min(0).default(0).describe("minutes to wait before a ONE-TIME run (ignored when cron is set)"),
    cron: z.string().nullable().default(null).describe("standard 5/6-field cron expression for a RECURRING task, e.g. '0 9 * * *' (daily 9am). Re-arms itself after each successful run. null = one-time."),
    tools: z.array(z.string()).nullable().default(null).describe("tool names the task may use; null = inherit full scope"),
    note: z.string().nullable().default(null).describe("short label for the queue UI"),
  }),
  execute: async ({ prompt, delayMinutes, cron, tools, note }) => {
    const pending = (await getTasks()).filter((t) => t.status === "pending").length;
    if (pending >= MAX_PENDING)
      return `Rejected: ${pending} tasks already queued (cap ${MAX_PENDING}). Let some run or clear them before scheduling more.`;
    if (cron && !isValidCron(cron)) return `Rejected: '${cron}' is not a valid cron expression.`;
    const runAfter = cron ? (nextCronRun(cron) ?? Date.now()) : Date.now() + Math.min(Math.max(0, delayMinutes * 60_000), MAX_DELAY_MS);
    const task = await enqueueTask({
      prompt,
      runAfter,
      cron: cron ?? undefined,
      allowlist: tools && tools.length ? tools : null,
      toolAllowlistLocked: Boolean(tools && tools.length),
      note: note ?? undefined,
    });
    await appendEvent(task.id, "schedule", `${cron ? `cron ${cron}` : `+${Math.round((runAfter - Date.now()) / 60_000)}m`}: ${prompt.slice(0, 80)}`);
    const when = cron ? `on schedule '${cron}' (first: ${new Date(runAfter).toLocaleString()})` : (runAfter - Date.now() < 60_000 ? "shortly" : `in ~${Math.round((runAfter - Date.now()) / 60_000)} min`);
    const armed = S.autonomous
      ? "autonomous mode is on, so it runs on the next visible idle moment after each due time."
      : "autonomous mode is OFF, so it won't run until you enable it in settings.";
    return `Scheduled task ${task.id} to run ${when}. ${armed}`;
  },
});
