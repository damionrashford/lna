// Building the SandboxAgent: static default instructions, the dynamic (context-derived) instructions,
// and buildAgent() which assembles the full capability set. transport.ts runs the returned agent.
import { Manifest, SandboxAgent, shell, filesystem, skills, memory, compaction, gitRepo } from "@openai/agents/sandbox";
import { S } from "../../store";
import type { AutomoContext } from "../runtime/context";
import { activeMcpServers } from "../mcp/index";
import { webSearchTool } from "../tools/search";
import { agentInputGuardrails, agentOutputGuardrails } from "../runtime/guardrails";

const DEFAULT_INSTRUCTIONS = `You are AUTOMO, a local-first AI assistant running in the user's browser, connected to their own machine over Local Network Access. You operate a real Unix sandbox on their machine:
- shell (exec_command): run commands in the workspace.
- filesystem + apply_patch: read and edit files in the workspace.
- skills: load reusable skills on demand.
- memory: persist durable notes across sessions.
- web_search: search the web (DuckDuckGo) for current information.
Prefer tools over guessing. Search the web for anything time-sensitive or that you're unsure of. Read a file before answering questions about it. Be concise and direct.`;

// Dynamic instructions — evaluated per run from the run's AutomoContext (see buildAgent). This is the
// Agent/LLM-context seam: whatever the model should know about the run environment goes here.
export function buildInstructions(ctx: AutomoContext): string {
  const base = ctx.settings.systemPrompt || DEFAULT_INSTRUCTIONS;
  const folder = ctx.env.folder ?? "none";
  const mcp = ctx.env.mcpServers;
  return `${base}\n\n[Run context — model: ${ctx.settings.model || "unknown"} · granted folder: ${folder} · MCP servers: ${mcp.length ? mcp.join(", ") : "none"} · date: ${ctx.env.startedAt}]`;
}

// build the SandboxAgent (typed over AutomoContext) with the full capability set. instructions is a
// FUNCTION of the run context, so the run-environment line is derived per turn.
export function buildAgent(modelOverride?: string): SandboxAgent<AutomoContext> {
  const model = modelOverride || S.model;
  return new SandboxAgent<AutomoContext>({
    name: "AUTOMO",
    model,
    instructions: (rc) => buildInstructions(rc.context),
    defaultManifest: new Manifest({ entries: {} }),
    tools: [webSearchTool],
    // connected MCP servers become the agent's tools (SDK owns exposure); server-prefixed names avoid
    // collisions across servers. This is the real fix for the previously orphaned MCP tool path.
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
          index: [{ name: "sum-writer", description: "Compute a sum and write it to a file (from the lna repo)." }],
        },
      }),
      memory({ generate: { phaseOneModel: model, phaseTwoModel: model } }),
      compaction(),
    ],
  });
}
