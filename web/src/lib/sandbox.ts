// BrowserSandboxClient — the browser side of AUTOMO's sandbox. It implements the SDK's
// SandboxClient/SandboxSession/Editor interfaces by RPC'ing every call to the LNA bridge,
// which hosts the REAL UnixLocalSandboxClient. So the in-browser @openai/agents SandboxAgent
// drives a genuine Unix sandbox on the user's machine over Local Network Access.
import type { SandboxClient, SandboxSession } from "@openai/agents/sandbox";
import { authFrame } from "./handshake";

/* eslint-disable @typescript-eslint/no-explicit-any */
const b64ToU8 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
// chunked: String.fromCharCode(...u) overflows the argument limit (RangeError) past ~100k bytes,
// and readFile / persistWorkspace routinely carry megabytes.
export const u8ToB64 = (u: Uint8Array) => {
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000) as unknown as number[]);
  return btoa(s);
};

function plain(x: any) { try { return JSON.parse(JSON.stringify(x)); } catch { return x; } }
function serializeManifest(m: any) {
  if (!m) return { entries: {} };
  const src = m.entries !== undefined ? m : (m.manifest ?? m);
  return { entries: plain(src.entries ?? {}), environment: plain(src.environment ?? {}) };
}

const RPC_TIMEOUT_MS = 120000;

// one WS to the bridge, request/response correlated by id
class BridgeRPC {
  private ws: WebSocket | null = null;
  private ready: Promise<void> | null = null;
  private pending = new Map<string, { res: (v: any) => void; rej: (e: any) => void }>();
  private n = 0;
  private closed = new AbortController(); // aborts all in-flight RPCs when the socket drops
  constructor(private url: string, private token: string) {}

  private connect(): Promise<void> {
    if (this.ready) return this.ready;
    this.closed = new AbortController();
    this.ready = new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.onmessage = async (e) => {
        const m = JSON.parse(e.data);
        if (m.type === "hello") { ws.send(await authFrame(this.token, m.nonce)); return; } // answer the nonce challenge
        if (m.type === "auth") { m.ok ? resolve() : reject(new Error("bridge auth failed")); return; }
        if (m.type === "sb") { const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); m.ok ? p.res(m.result) : p.rej(new Error(m.error)); } }
      };
      ws.onopen = () => {}; // auth is sent in reply to the bridge's hello (nonce challenge)
      ws.onerror = () => reject(new Error("bridge not reachable — start it: bun run bridge"));
      ws.onclose = () => { this.ready = null; this.ws = null; this.closed.abort(); };
    });
    return this.ready;
  }

  // Each RPC settles on the bridge reply, a per-call timeout, or the socket dropping — composed with
  // AbortSignal.any so a closed connection cancels every pending call at once (no leaked promises).
  async rpc(op: string, extra: Record<string, any> = {}): Promise<any> {
    await this.connect();
    const id = "r" + ++this.n;
    return new Promise((res, rej) => {
      const signal = AbortSignal.any([AbortSignal.timeout(RPC_TIMEOUT_MS), this.closed.signal]);
      const onAbort = () => {
        if (!this.pending.delete(id)) return;
        rej(new Error((signal.reason as any)?.name === "TimeoutError" ? `sandbox ${op} timed out` : "bridge closed"));
      };
      const done = () => signal.removeEventListener("abort", onAbort);
      this.pending.set(id, { res: (v) => { done(); res(v); }, rej: (e) => { done(); rej(e); } });
      signal.addEventListener("abort", onAbort, { once: true });
      this.ws!.send(JSON.stringify({ type: "sb", id, op, ...extra }));
    });
  }
}

class BrowserSandboxSession implements SandboxSession<any> {
  constructor(private rpc: BridgeRPC, private sid: string, public state: any) {}
  exec = (args: any) => this.rpc.rpc("exec", { sid: this.sid, args });
  execCommand = (args: any) => this.rpc.rpc("execCommand", { sid: this.sid, args });
  writeStdin = (args: any) => this.rpc.rpc("writeStdin", { sid: this.sid, args });
  supportsPty = () => !!(this.state as any)?.supportsPty;
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
  // pre-stop hooks — the memory() capability registers a flush hook here; without these methods the
  // SDK could never fire memory generation (Phase 1/2 that build MEMORY.md). runPreStopHooks() must be
  // invoked (by us, on session reset) while the session is still open so the flush can RPC the bridge.
  private _preStop: Array<() => Promise<void> | void> = [];
  registerPreStopHook = (hook: () => Promise<void> | void) => {
    this._preStop.push(hook);
    return () => { this._preStop = this._preStop.filter((h) => h !== hook); };
  };
  runPreStopHooks = async () => { for (const h of this._preStop) { try { await h(); } catch { /* best-effort flush */ } } };
  close = () => this.rpc.rpc("close", { sid: this.sid });
}

export class BrowserSandboxClient implements SandboxClient<any, any> {
  backendId = "browser-lna-bridge";
  private rpc: BridgeRPC;
  constructor(url = "ws://127.0.0.1:7967/ws", token = "dev") { this.rpc = new BridgeRPC(url, token); }
  create = async (args?: any): Promise<any> => {
    // args may be a Manifest, {manifest}, or SandboxClientCreateArgs
    const manifest = serializeManifest(args?.manifest ?? args);
    const { sid, state, supportsPty } = await this.rpc.rpc("create", { manifest });
    return new BrowserSandboxSession(this.rpc, sid, { ...state, supportsPty, manifest: args?.manifest ?? args, environment: state.environment ?? {} });
  };
}
