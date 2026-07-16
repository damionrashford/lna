// BrowserSandboxClient — the browser side of AUTOMO's sandbox. It implements the SDK's
// SandboxClient/SandboxSession/Editor interfaces by RPC'ing every call to the LNA bridge,
// which hosts the REAL UnixLocalSandboxClient. So the in-browser @openai/agents SandboxAgent
// drives a genuine Unix sandbox on the user's machine over Local Network Access.
import type { SandboxClient, SandboxSession } from "@openai/agents/sandbox";

/* eslint-disable @typescript-eslint/no-explicit-any */
const b64ToU8 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const u8ToB64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));

function plain(x: any) { try { return JSON.parse(JSON.stringify(x)); } catch { return x; } }
function serializeManifest(m: any) {
  if (!m) return { entries: {} };
  const src = m.entries !== undefined ? m : (m.manifest ?? m);
  return { entries: plain(src.entries ?? {}), environment: plain(src.environment ?? {}) };
}

// one WS to the bridge, request/response correlated by id
class BridgeRPC {
  private ws: WebSocket | null = null;
  private ready: Promise<void> | null = null;
  private pending = new Map<string, { res: (v: any) => void; rej: (e: any) => void }>();
  private n = 0;
  constructor(private url: string, private token: string) {}

  private connect(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.type === "auth") { m.ok ? resolve() : reject(new Error("bridge auth failed")); return; }
        if (m.type === "sb") { const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); m.ok ? p.res(m.result) : p.rej(new Error(m.error)); } }
      };
      ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token: this.token }));
      ws.onerror = () => reject(new Error("bridge not reachable — start it: bun run bridge"));
      ws.onclose = () => { this.ready = null; this.ws = null; this.pending.forEach((p) => p.rej(new Error("bridge closed"))); this.pending.clear(); };
    });
    return this.ready;
  }

  async rpc(op: string, extra: Record<string, any> = {}): Promise<any> {
    await this.connect();
    const id = "r" + ++this.n;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws!.send(JSON.stringify({ type: "sb", id, op, ...extra }));
      setTimeout(() => { if (this.pending.delete(id)) rej(new Error(`sandbox ${op} timed out`)); }, 120000);
    });
  }
}

class BrowserSandboxSession implements SandboxSession<any> {
  constructor(private rpc: BridgeRPC, private sid: string, public state: any) {}
  exec = (args: any) => this.rpc.rpc("exec", { sid: this.sid, args });
  execCommand = (args: any) => this.rpc.rpc("execCommand", { sid: this.sid, args });
  writeStdin = (args: any) => this.rpc.rpc("writeStdin", { sid: this.sid, args });
  supportsPty = () => false;
  pathExists = (path: string, runAs?: string) => this.rpc.rpc("pathExists", { sid: this.sid, path, runAs });
  listDir = (args: any) => this.rpc.rpc("listDir", { sid: this.sid, args });
  viewImage = (args: any) => this.rpc.rpc("viewImage", { sid: this.sid, args });
  materializeEntry = (args: any) => this.rpc.rpc("materializeEntry", { sid: this.sid, args });
  applyManifest = (manifest: any, runAs?: string) => this.rpc.rpc("applyManifest", { sid: this.sid, manifest: serializeManifest(manifest), runAs });
  resolveExposedPort = (port: number) => this.rpc.rpc("resolveExposedPort", { sid: this.sid, port });
  async readFile(args: any): Promise<Uint8Array> { const r = await this.rpc.rpc("readFile", { sid: this.sid, args }); return b64ToU8(r.b64); }
  async persistWorkspace(): Promise<Uint8Array> { const r = await this.rpc.rpc("persistWorkspace", { sid: this.sid }); return b64ToU8(r.b64); }
  async hydrateWorkspace(data: any): Promise<void> { const u = data instanceof Uint8Array ? data : new Uint8Array(data); await this.rpc.rpc("hydrateWorkspace", { sid: this.sid, b64: u8ToB64(u) }); }
  createEditor(runAs?: string) {
    const call = (operation: any) => this.rpc.rpc("editorApply", { sid: this.sid, runAs, operation });
    return { createFile: call, updateFile: call, deleteFile: call } as any;
  }
  close = () => this.rpc.rpc("close", { sid: this.sid });
}

export class BrowserSandboxClient implements SandboxClient<any, any> {
  backendId = "browser-lna-bridge";
  private rpc: BridgeRPC;
  constructor(url = "ws://127.0.0.1:7967/ws", token = "dev") { this.rpc = new BridgeRPC(url, token); }
  create = async (args?: any): Promise<any> => {
    // args may be a Manifest, {manifest}, or SandboxClientCreateArgs
    const manifest = serializeManifest(args?.manifest ?? args);
    const { sid, state } = await this.rpc.rpc("create", { manifest });
    return new BrowserSandboxSession(this.rpc, sid, { ...state, manifest: args?.manifest ?? args, environment: state.environment ?? {} });
  };
}
