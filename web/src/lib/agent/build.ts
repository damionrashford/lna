// Builds the SandboxAgent: static default instructions, dynamic (context-derived) instructions, and
// buildAgent(), which assembles the full capability set. transport.ts runs the returned agent.
import { Manifest, SandboxAgent, shell, filesystem, skills, memory, compaction, gitRepo } from "@openai/agents/sandbox";
import { S } from "../../store";
import type { AutomoContext } from "../runtime/context/run-context";
import { activeMcpServers } from "../mcp/index";
import { webSearchTool, readUrlTool } from "../tools/search";
import { planTool } from "../tools/plan";
import { scheduleTool } from "../tools/schedule";
import { subagentTool } from "../tools/subagent";
import { SKILLS_INDEX } from "./skills.generated";
import { agentInputGuardrails, agentOutputGuardrails } from "../runtime/context/guardrails";
import { personalize } from "../runtime/context/profile";

const DEFAULT_INSTRUCTIONS = `You are AUTOMO, a local-first AI assistant running in the user's browser, connected to their own machine over Local Network Access. You operate a real Unix sandbox on their machine:
- shell (exec_command): run commands in the workspace.
- filesystem + apply_patch: read and edit files in the workspace.
- skills: load reusable skills on demand.
- memory: persist durable notes across sessions.
- web_search: search the web (DuckDuckGo) for current information.
Prefer tools over guessing. Search the web for anything time-sensitive or that you're unsure of. Read a file before answering questions about it. Be concise and direct.`;

// Dynamic instructions — evaluated per run from the run's AutomoContext (see buildAgent). Whatever the
// model should know about the run environment goes here.
export function buildInstructions(ctx: AutomoContext): string {
  const base = personalize(ctx.settings.systemPrompt || DEFAULT_INSTRUCTIONS);
  const folder = ctx.env.folder ?? "none";
  const mcp = ctx.env.mcpServers;
  return `${base}\n\n[Run context — model: ${ctx.settings.model || "unknown"} · granted folder: ${folder} · MCP servers: ${mcp.length ? mcp.join(", ") : "none"} · date: ${ctx.env.startedAt}]\n[Environment — ${ctx.env.capabilities}. Work within what's available: when offline, rely on memory and the sandbox rather than web_search or a remote model.]`;
}

// Build the SandboxAgent (typed over AutomoContext) with the full capability set. instructions is a
// function of the run context, so the run-environment line is derived per turn.
export function buildAgent(modelOverride?: string): SandboxAgent<AutomoContext> {
  const model = modelOverride || S.model;
  return new SandboxAgent<AutomoContext>({
    name: "AUTOMO",
    model,
    instructions: (rc) => buildInstructions(rc.context),
    defaultManifest: new Manifest({ entries: {} }),
    tools: [webSearchTool, readUrlTool, planTool, scheduleTool, subagentTool],
    // Connected MCP servers become the agent's tools (SDK owns exposure); server-prefixed tool names
    // avoid collisions across servers.
    mcpServers: activeMcpServers(),
    mcpConfig: { includeServerInToolNames: true },
    inputGuardrails: agentInputGuardrails,
    outputGuardrails: agentOutputGuardrails,
    capabilities: [
      shell(),
      filesystem(),
      skills({
        lazyFrom: {
          source: gitRepo({ host: "github.com", repo: "damionrashford/lna", ref: "main", subpath: ".agents/skills" }),
          // A remote gitRepo can't be enumerated client-side, so the index is precomputed at build
          // time (web/gen-skills-index.ts from ../.agents/skills/*/SKILL.md), not hand-maintained.
          index: SKILLS_INDEX,
        },
      }),
      memory({ generate: { phaseOneModel: model, phaseTwoModel: model } }),
      compaction(),
    ],
  });
}
