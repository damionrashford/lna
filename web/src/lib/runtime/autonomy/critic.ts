// Critic gate — an LLM-as-judge OUTPUT GUARDRAIL, not a bolt-on second agent. A critic is exactly what
// the SDK's output-guardrail seam is for: run a check over the agent's final output and trip a tripwire
// when it's unacceptable. Here the check is "does this output actually satisfy the task goal?" — because
// "the model stopped" is not "the goal was met." Attached per-run by the autonomous loop (with that
// task's goal); the loop catches the tripwire and turns it into a retry.
//
// It judges through the SAME brain as everything else — a tiny tool-less Agent over the installed default
// model provider (Ollama shim / vLLM native / in-browser), never a hand-rolled client to a hardcoded URL.
// Fail-open: any judging error passes, so the critic never wedges a run.
import { Agent, run, type OutputGuardrail } from "@openai/agents";
import { S, logEvent } from "../../../store";
import { installModelProvider } from "../model/model";
import { repairJson } from "./repair";

const CRITIC_PROMPT = `You are a strict reviewer. Given a TASK and the RESULT an agent produced, decide whether the result genuinely and completely satisfies the task.
Judge only what the result demonstrates — do not assume unstated work happened. Partial, vague, or "I will do X" answers FAIL.
Respond with ONLY a JSON object: {"pass": boolean, "reason": "<one concise sentence>"}.`;

/* eslint-disable @typescript-eslint/no-explicit-any */
// Build an output guardrail that fails the run when the output doesn't satisfy `goal`. outputInfo carries
// the judge's reason so the caller can thread it into a retry note.
export function criticGuardrail(goal: string): OutputGuardrail {
  return {
    name: "goal-critic",
    execute: async ({ agentOutput }) => {
      const result = String(agentOutput ?? "");
      try {
        installModelProvider(S.model); // ensure the default provider is the user's configured brain
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
