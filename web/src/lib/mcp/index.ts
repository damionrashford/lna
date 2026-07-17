// MCP server management. Builds MCP client instances and hands the connected ones to the SandboxAgent
// via Agent.mcpServers, so the SDK owns tool exposure, server-prefixed names, filtering, _meta, and
// structuredContent. Config persists to localStorage; the instances themselves are live.
import { set } from "../../store";
import { makeMcpServer, type SdkMcpServer, type McpServerConfig } from "./server";

export type { McpServerConfig };

type Entry = { cfg: McpServerConfig; server: SdkMcpServer | null; connected: boolean; error: string | null; tools: number };

let configs: McpServerConfig[] = [];
try { configs = JSON.parse(localStorage.getItem("automo.mcp") || "[]"); } catch { configs = []; }
const entries: Entry[] = configs.map((cfg) => ({ cfg, server: null, connected: false, error: null, tools: 0 }));

function save() { localStorage.setItem("automo.mcp", JSON.stringify(entries.map((e) => e.cfg))); }

export function syncMcpView() {
  set({ mcpView: entries.map((e) => ({ label: e.cfg.label, transport: e.cfg.transport, connected: e.connected, error: e.error, tools: e.tools })) });
}

// Typed as any[] because the instances structurally satisfy the SDK's MCPServer interface.
export function activeMcpServers(): any[] {
  return entries.filter((e) => e.connected && e.server).map((e) => e.server);
}
// Labels for the run-context line in the system prompt.
export function connectedMcpLabels(): string[] {
  return entries.filter((e) => e.connected).map((e) => e.cfg.label);
}

async function connectEntry(e: Entry) {
  e.error = null; e.connected = false;
  try {
    e.server = makeMcpServer(e.cfg);
    await e.server.connect();
    e.tools = e.server.toolCount();
    e.connected = true;
  } catch (err: any) {
    e.error = err?.message || String(err);
    e.server = null;
  }
  syncMcpView();
}

export function addMcpServer(label: string, transport: "http" | "stdio" | "inpage", target: string, auth: string) {
  const cfg: McpServerConfig = transport === "http"
    ? { label, transport, url: target, auth: auth || undefined }
    : transport === "inpage"
    ? { label, transport, server: target || label } // target = registered in-page server name (e.g. "browser")
    : { label, transport, cmd: target, bridge: "ws://127.0.0.1:7967/ws" };
  const e: Entry = { cfg, server: null, connected: false, error: null, tools: 0 };
  entries.push(e); save(); syncMcpView(); connectEntry(e);
}

export function removeMcpServer(i: number) {
  const e = entries[i]; if (!e) return;
  try { e.server?.close(); } catch { /* already closed */ }
  entries.splice(i, 1); save(); syncMcpView();
}

export function reconnectSaved() { syncMcpView(); entries.forEach((e) => connectEntry(e)); }

// Notify connected servers that the exposed roots (sandbox workspace) changed.
export function notifyRootsChanged() { entries.forEach((e) => e.server?.notifyRootsChanged()); }
