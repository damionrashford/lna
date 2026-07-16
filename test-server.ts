// Local daemon for the LNA test platform.
// Run: bun test-server.ts   (listens on 127.0.0.1:7966)
//
// HTTP: CORS-enabled JSON on any path — LNA gates the connection, CORS gates the read.
// WS:   echoes any message with a "echo: " prefix, for the WebSocket test.
const PORT = 7966;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  fetch(req: Request, srv) {
    // upgrade WebSocket handshakes
    if (srv.upgrade(req)) return;
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    return Response.json(
      {
        ok: true,
        daemon: "lna-test-server",
        path: new URL(req.url).pathname,
        method: req.method,
        time: new Date().toISOString(),
        note: "Reading this from a public origin means the LNA permission was granted.",
      },
      { headers: { ...CORS, "Content-Type": "application/json" } },
    );
  },
  websocket: {
    open(ws) { ws.send("hello from lna-test-server"); },
    message(ws, msg) { ws.send(`echo: ${msg}`); },
  },
});

console.log(`lna test daemon → http://${server.hostname}:${server.port}/  (+ ws://${server.hostname}:${server.port})`);
