// Minimal local daemon for testing LNA from the deployed page.
// Run: bun test-server.ts  (listens on 127.0.0.1:7966)
// The CORS headers are what let the public page READ the response after
// the LNA permission is granted — LNA gates the connection, CORS gates the read.
const PORT = 7966;

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  fetch(req) {
    const headers = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Content-Type": "application/json",
    };
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
    return Response.json(
      {
        ok: true,
        daemon: "lna-test-server",
        machine: "the user's own device",
        time: new Date().toISOString(),
        note: "If you can read this from a public origin, the LNA permission was granted.",
      },
      { headers },
    );
  },
});

console.log(`lna test daemon → http://127.0.0.1:${PORT}/`);
