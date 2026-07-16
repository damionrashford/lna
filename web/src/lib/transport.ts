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
import { S } from "../store";
import { installOllamaShim } from "./ollama";
import { buildAgent, ensureSandbox } from "./agent";
import { requestApproval } from "./approvals";

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
    installOllamaShim(model);
    const agent = buildAgent(model);
    const session = await ensureSandbox();
    const input = toAgentInput(messages);
    const opts = { sandbox: { session }, stream: true, maxTurns: 24, signal: abortSignal } as any;

    return createUIMessageStream({
      onError: (e: any) =>
        e instanceof InputGuardrailTripwireTriggered || e instanceof OutputGuardrailTripwireTriggered
          ? `Blocked by the ${e instanceof InputGuardrailTripwireTriggered ? "input" : "output"} guardrail — a credential was detected. Turn stopped.`
          : e?.message || "run failed",
      execute: async ({ writer }: any) => {
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
      },
    }) as any;
  }
  async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> { return null; }
}
