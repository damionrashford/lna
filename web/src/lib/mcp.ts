// MCP: Streamable HTTP (direct fetch) + stdio (via the LNA bridge). Tools become the agent's tools.
import { localFetch } from "./net";
import { set } from "../store";

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface McpServer {
  label: string;
  transport: "http" | "stdio";
  url?: string;
  cmd?: string;
  bridge?: string;
  token?: string;
  auth?: string;
  headers?: Record<string, string>;
  allowed?: string[];
  blocked?: string[];
  tools?: { name: string; description?: string; inputSchema?: any }[];
  connected?: boolean;
  error?: string | null;
  _sid?: string;
}

export let mcpServers: McpServer[] = [];
try { mcpServers = JSON.parse(localStorage.getItem("automo.mcp") || "[]"); } catch { mcpServers = []; }

const mcpConns: Record<string, { request: (m: any) => Promise<any>; notify: (m: any) => void; close: () => void }> = {};
export let mcpRegistry: Record<string, { server: McpServer; tool: string }> = {};
let _mcpId = 0;

function saveMcp() {
  localStorage.setItem("automo.mcp", JSON.stringify(mcpServers.map((s) => ({
    label: s.label, transport: s.transport, url: s.url, cmd: s.cmd, bridge: s.bridge,
    token: s.token, auth: s.auth, headers: s.headers, allowed: s.allowed, blocked: s.blocked,
  }))));
}
const mcpKey = (label: string, tool: string) => ("mcp_" + label + "_" + tool).replace(/[^a-zA-Z0-9_-]/g, "_");

export function syncMcpView() {
  set({ mcpView: mcpServers.map((s) => ({
    label: s.label, transport: s.transport, connected: !!s.connected, error: s.error ?? null, tools: (s.tools || []).length,
  })) });
}

// Streamable HTTP transport: POST JSON-RPC; response is JSON or an SSE stream; carry Mcp-Session-Id.
async function mcpHttp(server: McpServer, msg: any): Promise<any> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": "2025-06-18",
    ...(server.headers || {}),
  };
  if (server.auth) headers["Authorization"] = /^Bearer /i.test(server.auth) ? server.auth : "Bearer " + server.auth;
  if (server._sid) headers["Mcp-Session-Id"] = server._sid;
  const res = await localFetch(server.url!, { method: "POST", headers, body: JSON.stringify(msg) });
  const sid = res.headers.get("Mcp-Session-Id"); if (sid) server._sid = sid;
  if (msg.id == null) return null;
  if ((res.headers.get("Content-Type") || "").includes("text/event-stream")) {
    const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = "";
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true }); let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        const p = line.slice(5).trim(); if (!p) continue;
        let o; try { o = JSON.parse(p); } catch { continue; }
        if (o.id === msg.id) { reader.cancel(); if (o.error) throw new Error(o.error.message); return o.result; }
      }
    }
    throw new Error("no response");
  }
  const o = await res.json(); if (o.error) throw new Error(o.error.message); return o.result;
}

// stdio transport: spawn the MCP server command through the bridge, speak JSON-RPC over stdin/stdout.
function mcpStdio(server: McpServer) {
  const ws = new WebSocket(server.bridge || "ws://127.0.0.1:7967/ws");
  let buf = ""; const pending: Record<number, (o: any) => void> = {}; let ready = false; const queue: (() => void)[] = [];
  ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token: server.token || "dev" }));
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === "auth") { const parts = server.cmd!.trim().split(/\s+/); ws.send(JSON.stringify({ type: "spawn", cmd: parts[0], args: parts.slice(1) })); }
    else if (m.type === "spawned") { ready = true; queue.splice(0).forEach((f) => f()); }
    else if (m.type === "stdout") {
      buf += m.data; let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue;
        let o; try { o = JSON.parse(line); } catch { continue; }
        if (o.id != null && pending[o.id]) { pending[o.id](o); delete pending[o.id]; }
      }
    } else if (m.type === "error") { server.error = m.error; }
  };
  const send = (msg: any) => { const go = () => ws.send(JSON.stringify({ type: "stdin", data: JSON.stringify(msg) + "\n" })); ready ? go() : queue.push(go); };
  return {
    request: (msg: any) => new Promise<any>((res, rej) => { pending[msg.id] = (o) => (o.error ? rej(new Error(o.error.message)) : res(o.result)); send(msg); setTimeout(() => { if (pending[msg.id]) { delete pending[msg.id]; rej(new Error("timeout")); } }, 60000); }),
    notify: (msg: any) => send(msg),
    close: () => ws.close(),
  };
}

export async function mcpConnect(server: McpServer) {
  server.tools = []; server.error = null; server.connected = false;
  try {
    const init = { jsonrpc: "2.0", id: ++_mcpId, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "automo", version: "1" } } };
    if (server.transport === "stdio") {
      const conn = mcpStdio(server); mcpConns[server.label] = conn;
      await conn.request(init); conn.notify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
      server.tools = (await conn.request({ jsonrpc: "2.0", id: ++_mcpId, method: "tools/list", params: {} })).tools || [];
    } else {
      await mcpHttp(server, init); await mcpHttp(server, { jsonrpc: "2.0", method: "notifications/initialized", params: {} });
      server.tools = (await mcpHttp(server, { jsonrpc: "2.0", id: ++_mcpId, method: "tools/list", params: {} })).tools || [];
    }
    server.connected = true;
  } catch (err: any) { server.error = err.message; }
  syncMcpView();
}

async function mcpCall(server: McpServer, tool: string, args: any): Promise<string> {
  const msg = { jsonrpc: "2.0", id: ++_mcpId, method: "tools/call", params: { name: tool, arguments: args } };
  const r = server.transport === "stdio" ? await mcpConns[server.label].request(msg) : await mcpHttp(server, msg);
  const text = (r.content || []).map((c: any) => (c.type === "text" ? c.text : "[" + c.type + "]")).join("\n");
  return text || JSON.stringify(r);
}

export function mcpTools() {
  mcpRegistry = {}; const out: any[] = [];
  for (const s of mcpServers) {
    if (!s.connected) continue;
    for (const t of s.tools || []) {
      if (s.allowed && s.allowed.length && !s.allowed.includes(t.name)) continue;
      if (s.blocked && s.blocked.includes(t.name)) continue;
      const k = mcpKey(s.label, t.name); mcpRegistry[k] = { server: s, tool: t.name };
      out.push({ type: "function", name: k, description: "[" + s.label + "] " + (t.description || t.name), parameters: t.inputSchema || { type: "object", properties: {} } });
    }
  }
  return out;
}

export function callRegistered(name: string, args: any) {
  const { server, tool } = mcpRegistry[name];
  return mcpCall(server, tool, args);
}

export function addMcpServer(label: string, transport: "http" | "stdio", target: string, auth: string) {
  const server: McpServer = transport === "http"
    ? { label, transport, url: target, auth: auth || undefined }
    : { label, transport, cmd: target, bridge: "ws://127.0.0.1:7967/ws", token: "dev" };
  mcpServers.push(server); saveMcp(); syncMcpView(); mcpConnect(server);
}
export function removeMcpServer(i: number) {
  try { mcpConns[mcpServers[i].label]?.close(); } catch { /* already closed */ }
  mcpServers.splice(i, 1); saveMcp(); syncMcpView();
}
export function reconnectSaved() { syncMcpView(); mcpServers.forEach((s) => mcpConnect(s)); }
