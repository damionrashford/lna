// Guardrails — SDK input/output guardrails (agent-level) + tool guardrails (function tools).
// All are gated on the Settings "guardrails" toggle (S.guardrails), so they no-op when off.
// AUTOMO is local-first, so these focus on not leaking credentials: warn on pasted secrets,
// block the final answer from echoing one, refuse to send secrets to web search, and redact
// secrets out of tool results before the model sees them.
import {
  defineToolInputGuardrail, defineToolOutputGuardrail, ToolGuardrailFunctionOutputFactory,
  type InputGuardrail, type OutputGuardrail,
} from "@openai/agents";
import { S } from "../store";

/* eslint-disable @typescript-eslint/no-explicit-any */
// Targeted, low-false-positive credential patterns.
const SECRET_RE = /(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{36}|gho_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{40,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
const hasSecret = (s: string) => SECRET_RE.test(s);
const redact = (s: string) => s.replace(new RegExp(SECRET_RE, "g"), "«redacted-credential»");
const textOf = (x: any) => (typeof x === "string" ? x : JSON.stringify(x ?? ""));

// ---- agent-level ----
// Input guardrail: block before the model runs if the user pasted a live credential.
export const agentInputGuardrails: InputGuardrail[] = [{
  name: "no-pasted-credentials",
  runInParallel: false, // block the model until this completes
  execute: async ({ input }) => {
    const trip = S.guardrails && hasSecret(textOf(input));
    return { tripwireTriggered: !!trip, outputInfo: trip ? "a credential was detected in the input" : null };
  },
}];

// Output guardrail: block the final answer if it would echo a credential.
export const agentOutputGuardrails: OutputGuardrail[] = [{
  name: "no-leaked-credentials",
  execute: async ({ agentOutput }) => {
    const trip = S.guardrails && hasSecret(String(agentOutput ?? ""));
    return { tripwireTriggered: !!trip, outputInfo: trip ? "a credential was detected in the output" : null };
  },
}];

// ---- tool-level (function tools, e.g. web_search) ----
// Input: refuse to send what looks like a credential to a web search.
export const noSecretsToWeb = defineToolInputGuardrail({
  name: "no-secrets-to-web",
  run: async ({ toolCall }) =>
    S.guardrails && hasSecret(toolCall.arguments || "")
      ? ToolGuardrailFunctionOutputFactory.rejectContent("Refusing to send what looks like a credential to a web search. Remove it and try again.")
      : ToolGuardrailFunctionOutputFactory.allow(),
});
// Output: redact credentials out of tool results before the model sees them.
export const redactToolSecrets = defineToolOutputGuardrail({
  name: "redact-tool-secrets",
  run: async ({ output }) => {
    const s = String(output ?? "");
    return S.guardrails && hasSecret(s)
      ? ToolGuardrailFunctionOutputFactory.rejectContent(redact(s))
      : ToolGuardrailFunctionOutputFactory.allow();
  },
});
