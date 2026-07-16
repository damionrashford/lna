// LNA stdio bridge — translates WebSocket ⇄ a child process's stdin/stdout/stderr.
// This is the piece LNA makes reachable: a PUBLIC page opens a WS to this LOCAL
// daemon (LNA-gated), and the daemon pipes a spawned process's stdio over that socket.
//
// Run: BRIDGE_TOKEN=dev bun bridge-server.ts   (listens on 127.0.0.1:7967)
//   optional: BRIDGE_ALLOW="bash,node,python3"  (comma-separated command allowlist)
//
// SECURITY: spawning is remote code execution if exposed. Two gates:
//   1. token handshake — the client must send the token before it can spawn
//   2. command allowlist — only these binaries may be launched
// Bound to 127.0.0.1. If you front this with a public tunnel, keep the token secret.

const PORT = 7967;
const TOKEN = Bun.env.BRIDGE_TOKEN || crypto.randomUUID();
const ALLOW = new Set(
  (Bun.env.BRIDGE_ALLOW || "bash,sh,zsh,node,bun,python3,echo,cat,npx,bunx,uvx,uv,deno").split(",").map((s) => s.trim()),
);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

type Conn = { authed: boolean; proc: any };

const server = Bun.serve<Conn, {}>({
  port: PORT,
  hostname: "127.0.0.1",
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      if (srv.upgrade(req, { data: { authed: false, proc: null } })) return;
      return new Response("upgrade failed", { status: 400 });
    }
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    // /  → info + the command allowlist (never returns the token)
    return Response.json(
      { ok: true, daemon: "lna-stdio-bridge", ws: `ws://127.0.0.1:${PORT}/ws`, allow: [...ALLOW], authRequired: true },
      { headers: { ...CORS, "Content-Type": "application/json" } },
    );
  },
  websocket: {
    open(ws) {
      ws.send(JSON.stringify({ type: "hello", allow: [...ALLOW], note: "send {type:'auth',token} first" }));
    },
    message(ws, raw) {
      let msg: any;
      try { msg = JSON.parse(String(raw)); } catch { return ws.send(JSON.stringify({ type: "error", error: "bad json" })); }
      const d = ws.data;

      if (msg.type === "auth") {
        d.authed = msg.token === TOKEN;
        return ws.send(JSON.stringify({ type: "auth", ok: d.authed, error: d.authed ? undefined : "bad token" }));
      }
      if (!d.authed) return ws.send(JSON.stringify({ type: "error", error: "not authed" }));

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
      if (msg.type === "kill") {
        if (d.proc) d.proc.kill();
        return;
      }
      ws.send(JSON.stringify({ type: "error", error: `unknown type "${msg.type}"` }));
    },
    close(ws) { if (ws.data.proc) ws.data.proc.kill(); },
  },
});

async function pump(stream: ReadableStream<Uint8Array>, onChunk: (s: string) => void) {
  const dec = new TextDecoder();
  for await (const chunk of stream) onChunk(dec.decode(chunk));
}

console.log(`lna stdio bridge → ws://127.0.0.1:${PORT}/ws`);
console.log(`  token: ${TOKEN}`);
console.log(`  allow: ${[...ALLOW].join(", ")}`);

export {};
