// In-page stdio MCP transport: no bridge, no process spawn. A Node stdio MCP server runs inside the
// page, constructing the SDK's StdioServerTransport over shimmed process stdin/stdout (see ./shims);
// InPageStdioTransport is the client end that pipes JSON-RPC to it. Same start/send/close/onmessage
// shape as BridgeStdioTransport in server.ts, but the pipe is an in-memory stdio shim rather than a
// WebSocket. The server's node:* builtin imports resolve to ./shims via the alias plugin in build.ts.
//
// A server "entry" builds its McpServer and connects it to StdioServerTransport(io.stdin, io.stdout).
// Register servers here and reference them by name in an MCP config.
import "./shims/buffer-global"; // Buffer global must exist before any server-side stdio framing runs
import { makeStdioPair } from "./shims/process";
import { logEvent } from "../../store";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type InPageStdio = { stdin: any; stdout: any };
export type InPageServerEntry = (io: InPageStdio) => Promise<void> | void;

const registry = new Map<string, InPageServerEntry>();
export function registerInPageServer(name: string, entry: InPageServerEntry) { registry.set(name, entry); }
export function inPageServerNames(): string[] { return [...registry.keys()]; }

// MCP Transport that drives an in-page stdio server.
export class InPageStdioTransport {
  onmessage?: (m: any) => void;
  onclose?: () => void;
  onerror?: (e: Error) => void;
  private pair: ReturnType<typeof makeStdioPair> | null = null;
  private buf = "";
  constructor(private name: string) {}

  async start(): Promise<void> {
    const entry = registry.get(this.name);
    if (!entry) throw new Error(`no in-page MCP server registered as "${this.name}"`);
    const pair = makeStdioPair();
    this.pair = pair;
    // Line-buffer the server's stdout into newline-delimited JSON-RPC messages.
    pair.onServerWrite((s) => {
      this.buf += s;
      let i;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        try { this.onmessage?.(JSON.parse(line)); } catch { /* not a JSON-RPC line (server log) */ }
      }
    });
    await entry(pair); // builds the server and connects its StdioServerTransport to this pair
    logEvent("info", `in-page MCP server "${this.name}" started`);
  }
  async send(message: any): Promise<void> { this.pair?.writeToServer(JSON.stringify(message) + "\n"); }
  async close(): Promise<void> { this.onclose?.(); this.pair = null; }
}

// Built-in in-page server (time + fetch).
const txt = (text: string) => ({ content: [{ type: "text" as const, text }] });

registerInPageServer("browser", async (io) => {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { z } = await import("zod");
  const server = new McpServer({ name: "browser", version: "1.0.0" });
  server.registerTool("get_current_time", { description: "Get the current local date and time.", inputSchema: {} }, async () => txt(new Date().toString()));
  server.registerTool(
    "fetch_text",
    { description: "Fetch a URL and return its readable text (HTML stripped), via a CORS proxy.", inputSchema: { url: z.string() } },
    async ({ url }: { url: string }) => {
      try {
        const r = await fetch("https://api.allorigins.win/raw?url=" + encodeURIComponent(url));
        const html = await r.text();
        return txt(html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 6000));
      } catch (e: any) { return txt("fetch failed: " + (e?.message ?? e)); }
    },
  );
  await server.connect(new (StdioServerTransport as any)(io.stdin, io.stdout));
});

// In-page server: the autonomous task queue surfaced over MCP.
// Projects the durable autonomy queue (runtime/autonomy/tasks) into MCP Tasks (taskId/status/ttl/…) so
// any MCP client, including the agent itself, can inspect and cancel autonomous work. list/get read the
// MCP-shaped projection; cancel drives the real queue. Status vocabulary matches the MCP Tasks spec.
registerInPageServer("automo-tasks", async (io) => {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { z } = await import("zod");
  const { listMcpTasks, getMcpTask, cancelTask, toMcpTask } = await import("../runtime/autonomy/tasks");
  const server = new McpServer({ name: "automo-tasks", version: "1.0.0" });
  server.registerTool("list_tasks", { description: "List AUTOMO's autonomous tasks as MCP Tasks (taskId, status, ttl, timestamps).", inputSchema: {} },
    async () => txt(JSON.stringify(await listMcpTasks(), null, 2)));
  server.registerTool("get_task", { description: "Get one autonomous task by id as an MCP Task.", inputSchema: { taskId: z.string() } },
    async ({ taskId }: { taskId: string }) => { const t = await getMcpTask(taskId); return txt(t ? JSON.stringify(t, null, 2) : `no task ${taskId}`); });
  server.registerTool("cancel_task", { description: "Cancel a non-terminal autonomous task by id.", inputSchema: { taskId: z.string(), reason: z.string().optional() } },
    async ({ taskId, reason }: { taskId: string; reason?: string }) => { const t = await cancelTask(taskId, reason); return txt(t ? JSON.stringify(toMcpTask(t), null, 2) : `no task ${taskId}`); });
  await server.connect(new (StdioServerTransport as any)(io.stdin, io.stdout));
});
