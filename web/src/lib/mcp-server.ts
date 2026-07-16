// Real MCP client for the browser, built the SAME SHAPE as the SDK's browser MCPServer classes —
// which are stubs that `throw new Error('Method not implemented.')` — but actually implemented. Each
// instance satisfies @openai/agents' `MCPServer` interface, so it plugs straight into
// SandboxAgent.mcpServers and the SDK owns tool exposure, server-prefixed names, tool filtering,
// _meta, structuredContent, and errorFunction. Two transports:
//   - Streamable HTTP: the raw MCP SDK StreamableHTTPClientTransport (fetch-based; LNA-hinted fetch).
//   - stdio: a custom Transport that pipes over our loopback bridge WebSocket — a browser can't spawn
//     a process, so the bridge spawns it and pipes stdio (the same spawn/stdin/stdout protocol we
//     already speak). This is why stdio can't use the SDK's local-spawn class.
// Elicitation (server→client structured-input requests) is answered via the Client's request handler,
// routed to our human-in-the-loop surface — the same idea as SDK tool approvals.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema, ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { localFetch } from "./net";
import { authFrame } from "./handshake";
import { requestElicitation } from "./approvals";
import { currentRoots } from "./roots";
import { S, logEvent, updateTask } from "../store";

/* eslint-disable @typescript-eslint/no-explicit-any */

// MCP Transport (start/send/close/onmessage/onclose/onerror) over the LNA bridge's stdio pipe.
class BridgeStdioTransport {
  onmessage?: (m: any) => void;
  onclose?: () => void;
  onerror?: (e: Error) => void;
  private ws: WebSocket | null = null;
  private buf = "";
  constructor(private url: string, private token: string, private command: string) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.onmessage = async (e) => {
        const m = JSON.parse(String(e.data));
        if (m.type === "hello") { ws.send(await authFrame(this.token, m.nonce)); return; } // HMAC handshake
        if (m.type === "auth") {
          if (!m.ok) { reject(new Error("bridge auth failed")); return; }
          const parts = this.command.trim().split(/\s+/);
          ws.send(JSON.stringify({ type: "spawn", cmd: parts[0], args: parts.slice(1) }));
          return;
        }
        if (m.type === "spawned") { resolve(); return; }
        if (m.type === "stdout") {
          this.buf += m.data;
          let i;
          while ((i = this.buf.indexOf("\n")) >= 0) {
            const line = this.buf.slice(0, i).trim();
            this.buf = this.buf.slice(i + 1);
            if (!line) continue;
            try { this.onmessage?.(JSON.parse(line)); } catch { /* not a JSON-RPC line */ }
          }
          return;
        }
        if (m.type === "exit" || m.type === "error") this.onclose?.();
      };
      ws.onerror = () => reject(new Error("bridge not reachable — start it: bun run bridge"));
      ws.onclose = () => this.onclose?.();
    });
  }
  async send(message: any): Promise<void> {
    this.ws?.send(JSON.stringify({ type: "stdin", data: JSON.stringify(message) + "\n" }));
  }
  async close(): Promise<void> {
    try { this.ws?.send(JSON.stringify({ type: "kill" })); } catch { /* noop */ }
    this.ws?.close();
    this.onclose?.();
  }
}

export interface McpServerConfig {
  label: string;
  transport: "http" | "stdio";
  url?: string;
  cmd?: string;
  bridge?: string;
  token?: string;
  auth?: string;
  headers?: Record<string, string>;
}

// One class satisfying the SDK's MCPServer interface, backed by a real MCP Client.
export class SdkMcpServer {
  name: string;
  cacheToolsList = true;
  private client: Client | null = null;
  private tools: any[] = [];
  constructor(cfg: McpServerConfig, private makeTransport: () => any) { this.name = cfg.label; }

  async connect(): Promise<void> {
    if (this.client) return; // idempotent — the Runner may also call connect()
    const client = new Client(
      { name: "automo", version: "1" },
      { capabilities: { elicitation: {}, roots: { listChanged: true }, tasks: { list: {}, cancel: {} } } },
    );
    // answer server→client input requests instead of dropping them (which would hang the server).
    // Cast: the runtime shape {action, content} is a valid MCP ElicitResult; the SDK's handler return
    // union is over-constrained (it also allows task-augmented results we don't produce).
    client.setRequestHandler(ElicitRequestSchema, ((req: any) => requestElicitation(this.name, req.params)) as any);
    // expose our filesystem roots (the sandbox workspace) so servers know where they may operate
    client.setRequestHandler(ListRootsRequestSchema, (async () => ({ roots: currentRoots() })) as any);
    await client.connect(this.makeTransport());
    this.client = client;
    this.tools = (await client.listTools()).tools || [];
    logEvent("info", `mcp ${this.name} connected · ${this.tools.length} tools`);
  }
  async listTools(): Promise<any[]> { return this.tools; }

  // tell the server our roots changed (new sandbox workspace); best-effort
  async notifyRootsChanged(): Promise<void> {
    try { await (this.client as any)?.sendRootsListChanged?.(); } catch { /* server may not support roots */ }
  }

  async callTool(toolName: string, args: Record<string, unknown> | null): Promise<any> {
    const tool = this.tools.find((t) => t.name === toolName);
    const taskSupport = tool?.execution?.taskSupport;
    // Long-running tools: run as a task and poll to completion via the SDK's task stream, surfacing
    // status to the UI, then return the final result — background processing without blocking.
    if (taskSupport === "required" || taskSupport === "optional") {
      const stream = (this.client as any).experimental.tasks.callToolStream({ name: toolName, arguments: (args || {}) as any });
      for await (const msg of stream as AsyncIterable<any>) {
        if (msg.type === "result") { updateTask(this.name, toolName, "completed"); return msg.result?.content ?? msg.result; }
        if (msg.type === "error") { updateTask(this.name, toolName, "failed"); throw new Error(msg.error?.message || `task ${toolName} failed`); }
        const status = msg.status?.status || msg.type;
        updateTask(this.name, toolName, status);
        logEvent("info", `task ${this.name}/${toolName}: ${status}`);
      }
      return null;
    }
    const r: any = await this.client!.callTool({ name: toolName, arguments: (args || {}) as any });
    return r.content;
  }
  async callToolResult(toolName: string, args: Record<string, unknown> | null): Promise<any> {
    return this.client!.callTool({ name: toolName, arguments: (args || {}) as any });
  }
  async invalidateToolsCache(): Promise<void> { this.tools = (await this.client!.listTools()).tools || []; }
  async close(): Promise<void> { try { await this.client?.close(); } catch { /* noop */ } this.client = null; }
  toolCount(): number { return this.tools.length; }
}

export function makeMcpServer(cfg: McpServerConfig): SdkMcpServer {
  if (cfg.transport === "http") {
    const auth = cfg.auth ? (/^Bearer /i.test(cfg.auth) ? cfg.auth : "Bearer " + cfg.auth) : undefined;
    return new SdkMcpServer(cfg, () =>
      new StreamableHTTPClientTransport(new URL(cfg.url!), {
        fetch: ((u: any, init: any) => localFetch(String(u), init)) as any, // LNA-hinted fetch
        requestInit: { headers: { ...(cfg.headers || {}), ...(auth ? { Authorization: auth } : {}) } },
      } as any));
  }
  return new SdkMcpServer(cfg, () =>
    new BridgeStdioTransport(cfg.bridge || "ws://127.0.0.1:7967/ws", cfg.token || S.bridgeToken, cfg.cmd || ""));
}
