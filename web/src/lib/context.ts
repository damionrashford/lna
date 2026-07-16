// AutomoContext — the app-local RunContext<T> for a single agent run, threaded through EVERY tool,
// tool/agent guardrail, hook, and the dynamic instructions (all of which the SDK hands a
// RunContext<AutomoContext>). It is the one source of run-scoped truth, replacing scattered reads of
// module globals (the `S` settings object, the folder handle, the mcp registry).
//
// Two hard rules from the SDK's context model:
//   1. NOT sent to the LLM. Only `instructions` + `input` reach the model — so anything here that the
//      model should see must be surfaced through buildInstructions(), not assumed visible.
//   2. NOT serialized into RunState (we resume from result.state and re-pass context each run()). So it
//      may hold LIVE HANDLES (the sandbox session) but MUST NOT hold SECRETS — the bridge token stays
//      in settings/localStorage and is used only at connect time, never parked in context.
import type { SandboxSession } from "@openai/agents/sandbox";
import { S, logEvent } from "../store";
import { getFsRoot } from "./opfs";
import { connectedMcpLabels } from "./mcp";

export interface AutomoContext {
  /** live sandbox session for this run (null until the bridge connects); used by tools like web_search */
  session: SandboxSession<any> | null;
  /** current conversation id — for tools/hooks that key state per conversation */
  sessionId: string | null;
  /** snapshot of user settings the tools/guardrails/instructions read — NO secrets (no bridge token) */
  settings: {
    ollamaUrl: string;
    model: string;
    visionModel: string;
    imageModel: string;
    systemPrompt: string;       // "" ⇒ built-in default
    requireApproval: boolean;
    guardrails: boolean;
  };
  /** run environment surfaced INTO the LLM via buildInstructions() */
  env: {
    folder: string | null;      // granted mirror-folder name, or null
    mcpServers: string[];       // connected MCP server labels
    startedAt: string;          // ISO date (yyyy-mm-dd)
  };
  /** structured logger tools/hooks can call — console today, a debug panel/telemetry sink later */
  log: (level: "info" | "warn" | "error", msg: string, data?: unknown) => void;
}

// Snapshot the current app state into an AutomoContext for one run. Called by the transport per turn.
export function buildContext(session: SandboxSession<any> | null, sessionId: string | null): AutomoContext {
  return {
    session,
    sessionId,
    settings: {
      ollamaUrl: S.url,
      model: S.model,
      visionModel: S.vision,
      imageModel: S.image,
      systemPrompt: S.instructions.trim(),
      requireApproval: S.approve,
      guardrails: S.guardrails,
    },
    env: {
      folder: getFsRoot()?.name ?? null,
      // sorted for byte-stable instructions: a deterministic prefix keeps the model's prompt cache
      // warm across turns (the trick both openclaw and hermes-agent lean on). startedAt is date-only
      // for the same reason — it stays identical all day.
      mcpServers: connectedMcpLabels().sort(),
      startedAt: new Date().toISOString().slice(0, 10),
    },
    log: (level, msg, data) =>
      logEvent(level, data !== undefined ? `${msg} ${typeof data === "string" ? data : JSON.stringify(data)}` : msg),
  };
}
