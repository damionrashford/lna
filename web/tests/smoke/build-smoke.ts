// Build the smoke harness (smoke.html) with the SAME node-alias + conditional-external as build.ts, so
// the in-page MCP shims and the optional in-browser deps resolve exactly as in production. Dev-only.
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // web/tests/smoke
const webRoot = join(here, "..", "..");               // web/
const shimsDir = join(webRoot, "src/lib/mcp/shims");
const NODE_SHIMS: Record<string, string> = {
  "node:process": "process.ts", "node:fs": "fs.ts", "node:fs/promises": "fs-promises.ts",
  "node:crypto": "crypto.ts", "node:url": "url.ts", "node:zlib": "node-zlib.ts",
};
let TF_WEB: string | null = null;
try { const m = (Bun as any).resolveSync("@huggingface/transformers", import.meta.dir); TF_WEB = join(dirname(m), "..", "dist", "transformers.web.js"); } catch { /* not installed */ }
const nodeShimPlugin = {
  name: "node-shims",
  setup(build: any) {
    build.onResolve({ filter: /^node:(process|fs|fs\/promises|crypto|url|zlib)$/ }, (args: any) => {
      const f = NODE_SHIMS[args.path]; return f ? { path: join(shimsDir, f) } : undefined;
    });
    if (TF_WEB) build.onResolve({ filter: /^@huggingface\/transformers$/ }, () => ({ path: TF_WEB }));
  },
};
const OPTIONAL = ["@huggingface/transformers", "kokoro-js", "@mlc-ai/web-llm", "sql.js", "isomorphic-git", "isomorphic-git/http/web", "just-bash", "just-bash/browser"];
const external = OPTIONAL.filter((p) => { try { (Bun as any).resolveSync(p, import.meta.dir); return false; } catch { return true; } });

const r = await Bun.build({
  entrypoints: [join(here, "smoke.html")], outdir: join(webRoot, "dist-smoke"), minify: false, sourcemap: "none",
  publicPath: "/", external, plugins: [nodeShimPlugin],
});
if (!r.success) { for (const l of r.logs) console.error(l); process.exit(1); }
console.log(`smoke built → dist-smoke/ (external: ${external.join(", ") || "none"})`);
