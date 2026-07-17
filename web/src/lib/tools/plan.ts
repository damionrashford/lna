// update_plan — a durable, model-maintained plan/todo the agent keeps as it works. It's both a reasoning
// aid and a progress artifact that survives compaction (the plan is re-rendered at the end of context so
// the goal stays in the model's recent attention). One hard invariant: at most one step in_progress at a
// time. Rendered live in the UI (store.plan). Standard @openai/agents function tool.
import { tool } from "@openai/agents";
import { z } from "zod";
import { setPlan } from "../../store";

const Step = z.object({
  title: z.string().describe("a short, concrete step"),
  status: z.enum(["pending", "in_progress", "completed"]),
});

export const planTool = tool({
  name: "update_plan",
  description:
    "Maintain a short ordered plan of the steps needed to finish the current task. Call it to create the plan up front and to revise it as you make progress. Keep it to the REAL remaining work (not a restatement of the request). Mark exactly one step as `in_progress` at a time; mark steps `completed` as you finish them. Call this before starting multi-step work and after each meaningful step.",
  parameters: z.object({ steps: z.array(Step).describe("the ordered plan") }),
  execute: async ({ steps }) => {
    if (steps.filter((s) => s.status === "in_progress").length > 1)
      return "Rejected: at most one step may be `in_progress` at a time — set only the current step to in_progress and try again.";
    setPlan(steps);
    const done = steps.filter((s) => s.status === "completed").length;
    const cur = steps.find((s) => s.status === "in_progress");
    return `Plan updated — ${done}/${steps.length} done${cur ? `; now: ${cur.title}` : ""}.`;
  },
});
