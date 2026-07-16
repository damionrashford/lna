// LNA bridge — the local sandbox host + stdio pipe that a PUBLIC page reaches over LNA.
//
// Two channels over one WebSocket (127.0.0.1:7967, LNA-gated, token-gated):
//   1. sandbox RPC  — hosts the SDK's UnixLocalSandboxClient. AUTOMO's in-browser
//      @openai/agents SandboxAgent drives a REAL Unix sandbox on this machine: exec,
//      apply_patch (V4A diffs), readFile/listDir, materializeEntry (manifest + gitRepo),
//      persist/hydrate (snapshots). The browser session is a thin proxy to this.
//   2. stdio spawn  — pipes a spawned process's stdin/stdout/stderr (stdio MCP servers).
//
// Run: BRIDGE_TOKEN=dev bun bridge.ts   (listens on 127.0.0.1:7967)
//   optional: BRIDGE_ALLOW="bash,node,python3"  (stdio-spawn command allowlist)
//
// SECURITY: this spawns processes + runs a real shell → remote code execution if exposed.
// Gates: token handshake before any op, spawn allowlist, bound to 127.0.0.1. Front it with a
// tunnel only if you keep the token secret. The sandbox exec is NOT allowlisted (that's the
// point — it's the agent's shell), so the token is the whole perimeter; guard it.
import { UnixLocalSandboxClient } from "@openai/agents/sandbox/local";
import { Manifest } from "@openai/agents/sandbox";

// rebuild a real Manifest from the browser's serialized {entries, environment} input
const toManifest = (input: any) => (input instanceof Manifest ? input : new Manifest(input ?? { entries: {} }));

/* eslint-disable @typescript-eslint/no-explicit-any */
const PORT = Number(Bun.env.BRIDGE_PORT) || 7967;
const TOKEN = Bun.env.BRIDGE_TOKEN || crypto.randomUUID();
const ALLOW = new Set(
  (Bun.env.BRIDGE_ALLOW || "bash,sh,zsh,node,bun,python3,echo,cat,npx,bunx,uvx,uv,deno").split(",").map((s) => s.trim()),
);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const sandboxClient = new UnixLocalSandboxClient();
const u8ToB64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const b64ToU8 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

// Auth: the browser proves it knows TOKEN by returning HMAC-SHA256(TOKEN, per-connection nonce), so
// the token itself never crosses the wire and a captured handshake can't be replayed. Web Crypto
// (SubtleCrypto) ships in Bun. A plaintext token is still accepted for older clients.
async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

type Conn = { authed: boolean; proc: any; sessions: Map<string, any>; nonce: string };

// dispatch one sandbox RPC op against a live UnixLocalSandboxSession
async function sandboxOp(d: Conn, msg: any): Promise<any> {
  const { op } = msg;
  if (op === "create") {
    const session: any = await (sandboxClient as any).create({ manifest: toManifest(msg.manifest) });
    const sid = crypto.randomUUID();
    d.sessions.set(sid, session);
    // forward supportsPty at create so the browser proxy can answer it synchronously — the shell
    // capability only registers write_stdin (interactive/long-running process control) when true.
    return { sid, state: serializeState(session.state), supportsPty: session.supportsPty?.() ?? false };
  }
  const session = d.sessions.get(msg.sid);
  if (!session) throw new Error("no sandbox session " + msg.sid);
  switch (op) {
    case "exec": return await session.exec(msg.args);
    case "execCommand": return await session.execCommand(msg.args);
    case "writeStdin": return await session.writeStdin(msg.args);
    case "supportsPty": return session.supportsPty?.() ?? false;
    case "pathExists": return await session.pathExists(msg.path, msg.runAs);
    case "readFile": { const r = await session.readFile(msg.args); return { b64: u8ToB64(r instanceof Uint8Array ? r : new TextEncoder().encode(String(r))) }; }
    case "listDir": return await session.listDir(msg.args);
    case "viewImage": return await session.viewImage(msg.args);
    case "materializeEntry": { await session.materializeEntry(msg.args); return { ok: true }; }
    case "applyManifest": { await session.applyManifest(toManifest(msg.manifest), msg.runAs); return { ok: true }; }
    case "resolveExposedPort": return await session.resolveExposedPort(msg.port);
    case "editorApply": {
      const editor = session.createEditor(msg.runAs);
      const o = msg.operation;
      const fn = o.type === "create_file" ? editor.createFile : o.type === "delete_file" ? editor.deleteFile : editor.updateFile;
      return (await fn.call(editor, o)) ?? { status: "completed" };
    }
    case "persistWorkspace": return { b64: u8ToB64(await session.persistWorkspace()) };
    case "hydrateWorkspace": { await session.hydrateWorkspace(b64ToU8(msg.b64), msg.options); return { ok: true }; }
    case "close": { await session.close?.(); d.sessions.delete(msg.sid); return { ok: true }; }
    default: throw new Error("unknown sandbox op " + op);
  }
}

// only the JSON-serializable bits the browser session needs
function serializeState(state: any) {
  return {
    workspaceRootPath: state.workspaceRootPath,
    environment: state.environment ?? {},
    exposedPorts: state.exposedPorts ?? {},
    workspaceReady: state.workspaceReady ?? true,
  };
}

const server = Bun.serve<Conn, {}>({
  port: PORT,
  hostname: "127.0.0.1",
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      if (srv.upgrade(req, { data: { authed: false, proc: null, sessions: new Map(), nonce: "" } })) return;
      return new Response("upgrade failed", { status: 400 });
    }
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    return Response.json(
      { ok: true, daemon: "lna-bridge", ws: `ws://127.0.0.1:${PORT}/ws`, allow: [...ALLOW], sandbox: true, authRequired: true },
      { headers: { ...CORS, "Content-Type": "application/json" } },
    );
  },
  websocket: {
    open(ws) {
      ws.data.nonce = crypto.randomUUID();
      ws.send(JSON.stringify({ type: "hello", allow: [...ALLOW], sandbox: true, nonce: ws.data.nonce, note: "reply {type:'auth',hmac: HMAC-SHA256(token, nonce)}" }));
    },
    async message(ws, raw) {
      let msg: any;
      try { msg = JSON.parse(String(raw)); } catch { return ws.send(JSON.stringify({ type: "error", error: "bad json" })); }
      const d = ws.data;

      if (msg.type === "auth") {
        let ok = false;
        if (typeof msg.hmac === "string") ok = safeEqual(msg.hmac, await hmacHex(TOKEN, d.nonce));
        else if (typeof msg.token === "string") ok = safeEqual(msg.token, TOKEN); // legacy plaintext client
        d.authed = ok;
        return ws.send(JSON.stringify({ type: "auth", ok, error: ok ? undefined : "bad token" }));
      }
      if (!d.authed) return ws.send(JSON.stringify({ type: "error", error: "not authed" }));

      // ---- sandbox RPC (request/response, correlated by msg.id) ----
      if (msg.type === "sb") {
        try { const result = await sandboxOp(d, msg); ws.send(JSON.stringify({ type: "sb", id: msg.id, ok: true, result })); }
        catch (err: any) { ws.send(JSON.stringify({ type: "sb", id: msg.id, ok: false, error: err?.message || String(err) })); }
        return;
      }

      // ---- stdio spawn (streaming, for stdio MCP servers) ----
      if (msg.type === "spawn") {
        if (d.proc) return ws.send(JSON.stringify({ type: "error", error: "already spawned" }));
        const cmd = msg.cmd;
        if (!ALLOW.has(cmd)) return ws.send(JSON.stringify({ type: "error", error: `"${cmd}" not in allowlist` }));
        const args = Array.isArray(msg.args) ? msg.args.map(String) : [];
        try {
          const proc = Bun.spawn([cmd, ...args], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
          d.proc = proc;
          ws.send(JSON.stringify({ type: "spawned", pid: proc.pid, cmd, args }));
          pump(proc.stdout, (chunk) => ws.send(JSON.stringify({ type: "stdout", data: chunk })));
          pump(proc.stderr, (chunk) => ws.send(JSON.stringify({ type: "stderr", data: chunk })));
          proc.exited.then((code) => { ws.send(JSON.stringify({ type: "exit", code })); d.proc = null; });
        } catch (err: any) {
          ws.send(JSON.stringify({ type: "error", error: `spawn failed: ${err.message}` }));
        }
        return;
      }
      if (msg.type === "stdin") {
        if (!d.proc) return ws.send(JSON.stringify({ type: "error", error: "no process" }));
        d.proc.stdin.write(msg.data ?? "");
        d.proc.stdin.flush?.();
        return;
      }
      if (msg.type === "kill") { if (d.proc) d.proc.kill(); return; }
      ws.send(JSON.stringify({ type: "error", error: `unknown type "${msg.type}"` }));
    },
    close(ws) {
      if (ws.data.proc) ws.data.proc.kill();
      for (const s of ws.data.sessions.values()) { try { s.close?.(); } catch { /* noop */ } }
      ws.data.sessions.clear();
    },
  },
});

async function pump(stream: ReadableStream<Uint8Array>, onChunk: (s: string) => void) {
  const dec = new TextDecoder();
  for await (const chunk of stream) onChunk(dec.decode(chunk));
}

console.log(`lna bridge → ws://127.0.0.1:${PORT}/ws  (sandbox host + stdio pipe)`);
console.log(`  token: ${TOKEN}`);
console.log(`  spawn allow: ${[...ALLOW].join(", ")}`);

export { server };
