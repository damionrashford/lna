// LLM-as-judge output guardrail: trips a tripwire when the final output fails the task goal. The
// autonomous loop attaches it per-run with the goal and turns a tripwire into a retry. Judges through
// the installed model provider (a tool-less Agent). Fail-open — a judging error passes the run.
import { Agent, run, type OutputGuardrail } from "@openai/agents";
import { S, logEvent } from "../../../store";
import { installModelProvider } from "../model/model";
import { repairJson } from "./repair";

const CRITIC_PROMPT = `You are a strict reviewer. Given a TASK and the RESULT an agent produced, decide whether the result genuinely and completely satisfies the task.
Judge only what the result demonstrates — do not assume unstated work happened. Partial, vague, or "I will do X" answers FAIL.
Respond with ONLY a JSON object: {"pass": boolean, "reason": "<one concise sentence>"}.`;

/* eslint-disable @typescript-eslint/no-explicit-any */
// outputInfo carries the judge's reason for the loop's retry note.
export function criticGuardrail(goal: string): OutputGuardrail {
  return {
    name: "goal-critic",
    execute: async ({ agentOutput }) => {
      const result = String(agentOutput ?? "");
      try {
        installModelProvider(S.model); // judge through the user's configured model provider
        const judge = new Agent({ name: "critic", model: S.model, instructions: CRITIC_PROMPT });
        const r: any = await run(judge, `TASK:\n${goal.slice(0, 4000)}\n\nRESULT:\n${result.slice(0, 8000)}`, { maxTurns: 1 } as any);
        const out = typeof r.finalOutput === "string" ? r.finalOutput : JSON.stringify(r.finalOutput ?? "");
        const v = repairJson(out) as { pass?: boolean; reason?: string } | undefined;
        if (!v || typeof v.pass !== "boolean") { logEvent("warn", "critic: unparseable verdict, passing"); return { tripwireTriggered: false, outputInfo: "verdict unparseable" }; }
        return { tripwireTriggered: !v.pass, outputInfo: (v.reason ?? "").slice(0, 200) };
      } catch (e: any) {
        logEvent("warn", "critic failed (passing): " + (e?.message || e));
        return { tripwireTriggered: false, outputInfo: "critic error" };
      }
    },
  };
}
