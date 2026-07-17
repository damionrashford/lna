// Static preview server for the built app — the target Playwright's webServer waits on. Serves web/dist
// with an SPA navigation fallback to index.html, so E2E runs against the REAL production bundle (not the
// dev server). Build with PUBLIC_PATH=/ first so assets resolve at the root (the Pages build uses /lna/).
import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(fileURLToPath(new URL(".", import.meta.url)), "..", "dist");
const port = Number(Bun.env.PORT ?? 4173);

const server = Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    // resolve within dist; a path traversal or a missing asset falls back to the SPA shell
    const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const safe = normalize(rel);
    let file = safe.startsWith("..") ? Bun.file(join(dist, "index.html")) : Bun.file(join(dist, safe));
    if (!(await file.exists())) file = Bun.file(join(dist, "index.html")); // client-routed navigation
    return new Response(file);
  },
});
console.log(`preview: serving ${dist} at http://localhost:${server.port}`);
