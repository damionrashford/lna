// AUTOMO chat context — the Vercel AI SDK UI `useChat` wired to the local SandboxAgent
// transport, with per-session UIMessage persistence + multimodal + image generation.
import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { useChat } from "@ai-sdk/react";
import { useStore, setStatus, S } from "./store";
import { LocalAgentTransport } from "./lib/runtime/transport";
import { loadUiMessages, saveUiMessages, resetSandbox, generateImageData, persistActiveWorkspace } from "./lib/agent";
import { acquireWakeLock, releaseWakeLock } from "./lib/platform/wakelock";
import { maybeCompact } from "./lib/runtime/compact";

/* eslint-disable @typescript-eslint/no-explicit-any */
const uid = () => (crypto as any).randomUUID?.() ?? Math.random().toString(36).slice(2);

export interface ChatApi {
  messages: any[];
  status: "submitted" | "streaming" | "ready" | "error";
  error: Error | undefined;
  busy: boolean;
  sendText: (text: string) => void;
  sendImage: (text: string, dataUrl: string) => void;
  generateImage: (prompt: string) => Promise<void>;
  clear: () => Promise<void>;
  stop: () => void;
  regenerate: () => void;
}
const Ctx = createContext<ChatApi | null>(null);
export function useAutomoChat(): ChatApi {
  const c = useContext(Ctx);
  if (!c) throw new Error("useAutomoChat must be used within <ChatProvider>");
  return c;
}

export function ChatProvider({ children }: { children: ReactNode }) {
  const { sessionId } = useStore();
  const transport = useMemo(() => new LocalAgentTransport(), []);
  const { messages, sendMessage, setMessages, status, error, stop, regenerate } = useChat({
    transport,
    onError: () => setStatus("err", "run failed"),
  }) as any;

  // load this session's messages when it changes; only persist for the loaded session
  const loadedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    loadedFor.current = null;
    loadUiMessages(sessionId).then((m) => { if (!cancelled) { setMessages(m); loadedFor.current = sessionId; } });
    return () => { cancelled = true; };
  }, [sessionId, setMessages]);

  // persist once a turn settles for the loaded session: conversation + durable sandbox workspace
  useEffect(() => {
    if (sessionId && loadedFor.current === sessionId && status === "ready") {
      saveUiMessages(sessionId, messages);
      persistActiveWorkspace();
      // client-side compaction (server-side is disabled by our shim); best-effort, only fires when large
      maybeCompact(messages, S.model).then((c) => {
        if (c && loadedFor.current === sessionId) { setMessages(c); saveUiMessages(sessionId, c); }
      });
    }
  }, [messages, status, sessionId, setMessages]);

  // hold a screen wake lock while a run is in flight so the machine doesn't sleep mid-task
  const running = status === "submitted" || status === "streaming";
  useEffect(() => { if (running) acquireWakeLock(); else releaseWakeLock(); }, [running]);

  const api = useMemo<ChatApi>(() => ({
    messages,
    status,
    error,
    busy: status === "submitted" || status === "streaming",
    sendText: (text) => { if (text.trim()) sendMessage({ text }); },
    sendImage: (text, dataUrl) => sendMessage({ role: "user", parts: [{ type: "text", text: text || "Describe this image." }, { type: "file", mediaType: "image/png", url: dataUrl }] }),
    generateImage: async (prompt) => {
      let next: any[] = [...messages, { id: uid(), role: "user", parts: [{ type: "text", text: prompt }] }];
      setMessages(next);
      try {
        const { dataUrl, caption } = await generateImageData(prompt);
        next = [...next, { id: uid(), role: "assistant", parts: [{ type: "file", mediaType: "image/png", url: dataUrl }, { type: "text", text: caption }] }];
      } catch (e: any) {
        next = [...next, { id: uid(), role: "assistant", parts: [{ type: "text", text: `Image generation failed (${e?.message || e}).` }] }];
      }
      setMessages(next);
      if (sessionId) await saveUiMessages(sessionId, next);
    },
    clear: async () => { setMessages([]); await resetSandbox(); if (sessionId) await saveUiMessages(sessionId, []); },
    stop,
    regenerate,
  }), [messages, status, error, sendMessage, setMessages, stop, regenerate, sessionId]);

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}
