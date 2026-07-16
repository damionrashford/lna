// The agent's tools: mem_* (OPFS), fs_* + apply_patch (granted folder), shell (bridge),
// http_fetch (exposed ports over LNA / the web), and any connected MCP server's tools.
import { localFetch, spaceFor } from "./net";
import { setCap } from "../store";
import { getFsRoot, globToRe, walk, resolvePath, opfsRoot, opfsReadFile, opfsWriteFile, mirrorMem } from "./opfs";
import { mcpRegistry, callRegistered, mcpTools } from "./mcp";

/* eslint-disable @typescript-eslint/no-explicit-any */

export const TOOLS_FS = [
  { type: "function", name: "fs_list", description: "List file paths in the granted folder matching a glob (e.g. **/*.md).", parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] } },
  { type: "function", name: "fs_read", description: "Read a text file from the granted folder by relative path.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { type: "function", name: "fs_write", description: "Create or overwrite a text file in the granted folder.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
];
export const TOOLS_MEM = [
  { type: "function", name: "mem_list", description: "List AUTOMO's private memory files (OPFS).", parameters: { type: "object", properties: {} } },
  { type: "function", name: "mem_read", description: "Read a private memory file. Use offset+limit to page through large files (e.g. spilled tool outputs) instead of loading the whole thing.", parameters: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } }, required: ["path"] } },
  { type: "function", name: "mem_write", description: "Write a private memory file (persists across sessions; mirrored to the granted folder if any).", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
];
export const TOOL_SHELL = { type: "function", name: "shell", description: "Run a shell command on the user's machine (bash -lc) via the local bridge. Returns stdout+stderr.", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } };
export const TOOL_APPLY_PATCH = { type: "function", name: "apply_patch", description: "Structured file edit in the granted folder: create_file, update_file (overwrite), or delete_file.", parameters: { type: "object", properties: { operation: { type: "string", enum: ["create_file", "update_file", "delete_file"] }, path: { type: "string" }, content: { type: "string" } }, required: ["operation", "path"] } };
export const TOOL_HTTP = { type: "function", name: "http_fetch", description: "Make an HTTP request to a URL — including localhost / LAN services exposed on the machine (over Local Network Access) or the public web. Returns status + body.", parameters: { type: "object", properties: { url: { type: "string" }, method: { type: "string" }, body: { type: "string" }, headers: { type: "object" } }, required: ["url"] } };

let bridgeReady = false;
export const isBridgeReady = () => bridgeReady;

export async function probeBridge() {
  try {
    const res = await localFetch("http://localhost:7967/", { method: "GET" });
    if (res.ok) { bridgeReady = true; setCap("bridge", "ok", "ready · shell tool"); return; }
  } catch { /* not running */ }
  bridgeReady = false; setCap("bridge", "", "not running");
}

export function bridgeExec(command: string): Promise<string> {
  return new Promise((resolve) => {
    let ws: WebSocket;
    try { ws = new WebSocket("ws://127.0.0.1:7967/ws"); } catch { return resolve("bridge not reachable"); }
    let out = "", err = "";
    const to = setTimeout(() => { try { ws.close(); } catch { /* noop */ } resolve("(timeout)\n" + out + err); }, 60000);
    ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token: "dev" }));
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === "auth") { if (!m.ok) { clearTimeout(to); ws.close(); return resolve("bridge auth failed"); } ws.send(JSON.stringify({ type: "spawn", cmd: "bash", args: ["-lc", command] })); }
      else if (m.type === "stdout") out += m.data;
      else if (m.type === "stderr") err += m.data;
      else if (m.type === "exit") { clearTimeout(to); ws.close(); resolve((out + err).slice(0, 20000) || `(exit ${m.code}, no output)`); }
      else if (m.type === "error") { clearTimeout(to); ws.close(); resolve("bridge error: " + m.error); }
    };
    ws.onerror = () => { clearTimeout(to); resolve("bridge not reachable — start it: bun servers/bridge.ts"); };
  });
}

export function buildTools() {
  const fsRoot = getFsRoot();
  return [...TOOLS_MEM, TOOL_HTTP, ...(fsRoot ? [...TOOLS_FS, TOOL_APPLY_PATCH] : []), ...(bridgeReady ? [TOOL_SHELL] : []), ...mcpTools()];
}

export async function execTool(name: string, a: any): Promise<string> {
  const cap = (s: any) => (typeof s === "string" ? s.slice(0, 20000) : s);
  const fsRoot = getFsRoot();
  if (mcpRegistry[name]) return cap(await callRegistered(name, a));
  if (name === "shell") return cap(await bridgeExec(a.command || ""));
  if (name === "http_fetch") {
    try {
      const sp = spaceFor(a.url); const opt: RequestInit = { method: a.method || "GET", headers: a.headers || {}, body: a.body };
      if (sp) (opt as any).targetAddressSpace = sp;
      const r = await fetch(a.url, opt); return cap(`HTTP ${r.status}\n` + (await r.text()));
    } catch (e: any) { return "fetch failed: " + e.message; }
  }
  if (name === "apply_patch") {
    if (!fsRoot) return "no folder granted";
    if (a.operation === "delete_file") { const { dir, file } = await resolvePath(fsRoot, a.path); await dir.removeEntry(file); return "deleted " + a.path; }
    const { dir, file } = await resolvePath(fsRoot, a.path, true); const fh = await dir.getFileHandle(file, { create: true }); const w = await fh.createWritable(); await w.write(a.content ?? ""); await w.close();
    return a.operation + " " + a.path;
  }
  if (name === "fs_list") { if (!fsRoot) return "no folder granted"; const re = globToRe(a.pattern || "**/*"); const out: string[] = []; for await (const f of walk(fsRoot)) { if (re.test(f.path)) out.push(f.path); if (out.length >= 500) break; } return JSON.stringify(out); }
  if (name === "fs_read") { if (!fsRoot) return "no folder granted"; const { dir, file } = await resolvePath(fsRoot, a.path); return cap(await (await (await dir.getFileHandle(file)).getFile()).text()); }
  if (name === "fs_write") { if (!fsRoot) return "no folder granted"; const { dir, file } = await resolvePath(fsRoot, a.path, true); const fh = await dir.getFileHandle(file, { create: true }); const w = await fh.createWritable(); await w.write(a.content ?? ""); await w.close(); return "wrote " + a.path; }
  if (name === "mem_list") { const out: string[] = []; for await (const f of walk(await opfsRoot())) out.push(f.path); return JSON.stringify(out); }
  if (name === "mem_read") { const full = await opfsReadFile(a.path); const off = a.offset || 0; const lim = a.limit || 8000; const slice = full.slice(off, off + lim); const more = full.length - (off + slice.length); return `[${a.path} · ${full.length} chars · showing ${off}–${off + slice.length}${more > 0 ? ` · ${more} more` : ""}]\n${slice}`; }
  if (name === "mem_write") { await opfsWriteFile(a.path, a.content); await mirrorMem(a.path, a.content); return "saved " + a.path + (fsRoot ? " (mirrored to .automo/memory/)" : ""); }
  return "unknown tool: " + name;
}
