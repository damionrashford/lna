// research — spawn a subagent for read-only fan-out. The main agent delegates a narrow research question
// to a fresh agent that has only search/read tools (web_search, read_url), its own isolated context, and
// its own turn budget. The subagent cannot write files, run the sandbox, schedule work, or touch the
// plan, so parallel/deep discovery can't corrupt the main run's state. Only its final summary comes back,
// keeping the main context small.
import { Agent, run, tool } from "@openai/agents";
import { z } from "zod";
import { S } from "../../store";
import { installModelProvider } from "../runtime/model/model";
import { webSearchTool, readUrlTool } from "./search";
import { toolOutputTrimmer } from "../runtime/context/trim";

const SUBAGENT_INSTRUCTIONS = `You are a research subagent. You have web_search and read_url only — you cannot write files or change anything. Investigate the brief, follow the most relevant sources, and return a concise findings summary: the answer first, then the key evidence with source URLs, then any important caveat or open question. Be specific and terse. Do not pad.`;

const SUB_MAX_TURNS = 12;

export const subagentTool = tool({
  name: "research",
  description:
    "Delegate a focused, read-only research question to a subagent that has web search + page reading and its own fresh context. Use it to investigate something in depth (or several things in parallel) without filling your own context with intermediate search results — you get back only the summary. The subagent cannot write files or take actions; it only researches and reports. Give it one specific, self-contained question.",
  parameters: z.object({
    brief: z.string().min(1).describe("one specific, self-contained research question with any needed context"),
  }),
  execute: async ({ brief }) => {
    const model = S.model;
    installModelProvider(model);
    const sub = new Agent({
      name: "researcher",
      model,
      instructions: SUBAGENT_INSTRUCTIONS,
      tools: [webSearchTool, readUrlTool],
    });
    const result: any = await run(sub, brief, { maxTurns: SUB_MAX_TURNS, callModelInputFilter: toolOutputTrimmer() } as any);
    const out = typeof result.finalOutput === "string" ? result.finalOutput : JSON.stringify(result.finalOutput ?? "");
    return out.trim() || "(subagent returned no findings)";
  },
});
