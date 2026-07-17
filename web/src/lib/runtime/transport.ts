// LocalAgentTransport — a serverless AI SDK UI ChatTransport. `useChat` calls sendMessages;
// instead of POSTing to a server, we run the in-browser @openai/agents SandboxAgent and translate
// its streamed run into a UIMessage stream with the maintained Agents→AI SDK bridge.
//
// Human-in-the-loop: when a tool needs approval the run PAUSES and returns interruptions. We wrap
// the whole pause→approve→resume loop in one createUIMessageStream so a single useChat turn keeps
// streaming: each run's chunks are merged in, and between runs we await the user's approve/reject
// (via the approval registry) then resume from result.state.
import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import { createUIMessageStream } from "ai";
import { run, InputGuardrailTripwireTriggered, OutputGuardrailTripwireTriggered } from "@openai/agents";
import { createAiSdkUiMessageStream } from "@openai/agents-extensions/ai-sdk-ui";
import { S, getState, setUsage, logEvent } from "../../store";
import { installModelProvider } from "./model";
import { buildAgent, ensureSandbox } from "../agent";
import { buildContext } from "./context";
import { toolOutputTrimmer } from "./trim";
import { requestApproval } from "../hitl/approvals";

/* eslint-disable @typescript-eslint/no-explicit-any */
const uid = () => Math.random().toString(36).slice(2, 10);

// AI SDK UIMessage[] → @openai/agents run input (text + input_image for vision)
function toAgentInput(messages: UIMessage[]): any[] {
  return messages.map((m: any) => {
    const parts = m.parts || [];
    const text = parts.filter((p: any) => p.type === "text").map((p: any) => p.text).join("");
    const images = parts.filter((p: any) => p.type === "file" && String(p.mediaType || "").startsWith("image/"));
    if (m.role === "user" && images.length) {
      return { role: "user", content: [{ type: "input_text", text: text || "Describe this image." }, ...images.map((p: any) => ({ type: "input_image", image_url: p.url }))] };
    }
    return { role: m.role === "assistant" ? "assistant" : "user", content: text };
  }).filter((x: any) => (typeof x.content === "string" ? x.content : x.content?.length));
}

const hasImage = (messages: UIMessage[]) =>
  (messages[messages.length - 1] as any)?.parts?.some((p: any) => p.type === "file" && String(p.mediaType || "").startsWith("image/"));

export class LocalAgentTransport implements ChatTransport<UIMessage> {
  async sendMessages({ messages, abortSignal }: Parameters<ChatTransport<UIMessage>["sendMessages"]>[0]): Promise<ReadableStream<UIMessageChunk>> {
    const model = hasImage(messages) ? S.vision || S.model : S.model;
    installModelProvider(model);
    const agent = buildAgent(model);
    const session = await ensureSandbox();
    const input = toAgentInput(messages);
    // context: the app-local RunContext (AutomoContext) for this run — sandbox session, settings
    // snapshot, run env, logger — read by every tool, guardrail, and the dynamic instructions.
    // callModelInputFilter trims old/oversized tool outputs before each model call — keeps a small local
    // model's context window from blowing out on long shell/search/file results (highest-ROI context lever).
    const opts = { sandbox: { session }, context: buildContext(session, getState().sessionId), stream: true, maxTurns: 24, signal: abortSignal, callModelInputFilter: toolOutputTrimmer() } as any;

    return createUIMessageStream({
      onError: (e: any) => {
        const guard = e instanceof InputGuardrailTripwireTriggered || e instanceof OutputGuardrailTripwireTriggered;
        const msg = guard
          ? `Blocked by the ${e instanceof InputGuardrailTripwireTriggered ? "input" : "output"} guardrail — a credential was detected. Turn stopped.`
          : e?.message || "run failed";
        logEvent(guard ? "warn" : "error", msg);
        return msg;
      },
      execute: async ({ writer }: any) => {
        logEvent("info", `run started · model ${model}`);
        let result: any = await run(agent, input as any, opts);
        writer.merge(createAiSdkUiMessageStream(result));
        await result.completed;
        // pause → approve/reject → resume, streaming each resumed run into the same message
        while (result.interruptions?.length && !abortSignal?.aborted) {
          for (const it of result.interruptions) {
            const raw = it.rawItem || {};
            const argsStr = typeof raw.arguments === "string" ? raw.arguments : JSON.stringify(raw.arguments ?? {});
            const decision = await requestApproval({ id: raw.id || raw.callId || uid(), name: raw.name || it.name || "tool", args: argsStr });
            if (decision.approved) result.state.approve(it);
            else result.state.reject(it, decision.message ? { message: decision.message } : undefined);
          }
          result = await run(agent, result.state, opts);
          writer.merge(createAiSdkUiMessageStream(result));
          await result.completed;
        }
        // surface aggregate token usage for this turn (RunContext.usage is cumulative in result.state)
        const u = result.state?.usage;
        setUsage(u ? { requests: u.requests || 0, input: u.inputTokens || 0, output: u.outputTokens || 0, total: u.totalTokens || 0 } : null);
      },
    }) as any;
  }
  async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> { return null; }
}
