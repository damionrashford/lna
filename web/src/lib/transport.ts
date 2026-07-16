// LocalAgentTransport — a serverless AI SDK UI ChatTransport. `useChat` calls sendMessages;
// instead of POSTing to a server, we run the in-browser @openai/agents SandboxAgent and convert
// its streamed run into a UIMessage stream with the maintained Agents→AI SDK translator.
import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import { run } from "@openai/agents";
import { createAiSdkUiMessageStream } from "@openai/agents-extensions/ai-sdk-ui";
import { S } from "../store";
import { installOllamaShim } from "./ollama";
import { buildAgent, ensureSandbox } from "./agent";

/* eslint-disable @typescript-eslint/no-explicit-any */

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
    const stream = await run(agent, input as any, { sandbox: { session }, stream: true, maxTurns: 24, signal: abortSignal } as any);
    return createAiSdkUiMessageStream(stream as any) as any;
  }
  async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> { return null; }
}
