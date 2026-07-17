// Browser-side MCP client that implements @openai/agents' MCPServer interface. The SDK's own browser
// MCPServer classes are stubs that throw 'Method not implemented.', so this reimplements them; each
// instance plugs straight into SandboxAgent.mcpServers and the SDK owns tool exposure, server-prefixed
// names, tool filtering, _meta, structuredContent, and errorFunction. Two transports:
//   - Streamable HTTP: the MCP SDK's StreamableHTTPClientTransport (fetch-based, LNA-hinted fetch).
//   - stdio: a custom Transport over the loopback bridge WebSocket. A browser can't spawn a process, so
//     the bridge spawns it and pipes stdio; that's why stdio can't use the SDK's local-spawn class.
// Elicitation (server→client structured-input requests) is answered via the Client's request handler,
// routed to the human-in-the-loop surface.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema, ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { localFetch } from "../net/index";
import { authFrame } from "../net/handshake";
import { requestElicitation } from "../hitl/approvals";
import { currentRoots } from "../sandbox/roots";
import { S, logEvent, updateTask } from "../../store";
import { InPageStdioTransport } from "./inpage";
import { getCurrentTaskId } from "../runtime/autonomy/current";
import { appendEvent, updateTask as updateAutonomyTask } from "../runtime/autonomy/tasks";

/* eslint-disable @typescript-eslint/no-explicit-any */

// MCP Transport over the LNA bridge's stdio pipe.
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
  transport: "http" | "stdio" | "inpage";
  url?: string;
  cmd?: string;
  server?: string;   // inpage: the registered in-page server name (see mcp/inpage.ts)
  bridge?: string;
  token?: string;
  auth?: string;
  headers?: Record<string, string>;
}

// Implements the SDK's MCPServer interface, backed by an MCP Client.
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
    // Answer server→client input requests; an unanswered request hangs the server. The cast satisfies
    // the SDK's over-constrained handler return union ({action, content} is a valid MCP ElicitResult).
    client.setRequestHandler(ElicitRequestSchema, ((req: any) => requestElicitation(this.name, req.params)) as any);
    // Expose the filesystem roots (sandbox workspace) so servers know where they may operate.
    client.setRequestHandler(ListRootsRequestSchema, (async () => ({ roots: currentRoots() })) as any);
    await client.connect(this.makeTransport());
    this.client = client;
    this.tools = (await client.listTools()).tools || [];
    logEvent("info", `mcp ${this.name} connected · ${this.tools.length} tools`);
  }
  async listTools(): Promise<any[]> { return this.tools; }

  // Tell the server the roots changed (new sandbox workspace); best-effort.
  async notifyRootsChanged(): Promise<void> {
    try { await (this.client as any)?.sendRootsListChanged?.(); } catch { /* server may not support roots */ }
  }

  async callTool(toolName: string, args: Record<string, unknown> | null): Promise<any> {
    const tool = this.tools.find((t) => t.name === toolName);
    const taskSupport = tool?.execution?.taskSupport;
    // Long-running tools run as a task, polled to completion via the SDK's task stream so status
    // surfaces to the UI without blocking, then the final result is returned.
    if (taskSupport === "required" || taskSupport === "optional") {
      // If an autonomous task triggered this call, mirror the MCP Task's status stream into that
      // durable task's event log and note, so a long-running MCP tool's progress is visible on the
      // autonomy task awaiting it. No-op during interactive chat (autoId null).
      const autoId = getCurrentTaskId();
      const mirror = (status: string) => { if (autoId) { void appendEvent(autoId, "tool", `${this.name}/${toolName}: ${status}`); void updateAutonomyTask(autoId, { note: `mcp ${toolName}: ${status}` }); } };
      const stream = (this.client as any).experimental.tasks.callToolStream({ name: toolName, arguments: (args || {}) as any });
      for await (const msg of stream as AsyncIterable<any>) {
        if (msg.type === "result") { updateTask(this.name, toolName, "completed"); mirror("completed"); return msg.result?.content ?? msg.result; }
        if (msg.type === "error") { updateTask(this.name, toolName, "failed"); mirror("failed"); throw new Error(msg.error?.message || `task ${toolName} failed`); }
        const status = msg.status?.status || msg.type;
        updateTask(this.name, toolName, status);
        mirror(status);
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
  if (cfg.transport === "inpage") {
    // Bridge-less path: a bundled stdio MCP server runs in the page over shimmed process stdio.
    return new SdkMcpServer(cfg, () => new InPageStdioTransport(cfg.server || cfg.label));
  }
  return new SdkMcpServer(cfg, () =>
    new BridgeStdioTransport(cfg.bridge || "ws://127.0.0.1:7967/ws", cfg.token || S.bridgeToken, cfg.cmd || ""));
}
