// Production build: bundle index.html (+ React/TSX + Tailwind + React Compiler) into static
// assets GitHub Pages can serve, then inject URL-dependent SEO + copy public/.
//
// The site URL is derived, not hardcoded, so a later custom domain needs no code change:
//   1. public/CNAME (how you set a GitHub Pages custom domain) → https://<domain>/ at the root.
//   2. else the repo itself → https://<owner>.github.io/<repo>/  (or /  for a <owner>.github.io repo),
//      read from GITHUB_REPOSITORY (CI) or `git remote get-url origin` (local).
//   3. env still overrides everything: SITE_ORIGIN and/or PUBLIC_PATH.
import tailwind from "bun-plugin-tailwind";
import { reactCompiler } from "../compiler";
import { writeSkillsIndex } from "./gen-skills-index";
import { cp } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// web/ root, relative to this script at web/scripts/ — used for module-relative resolves. The CWD-relative
// paths further down (./public, ./index.html, ./dist) assume the build runs from web/ (the package script).
const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// Alias the Node builtins that a bundled in-page stdio MCP server imports (e.g. the MCP SDK's
// StdioServerTransport → `import process from "node:process"`) to our browser shims, so such servers
// bundle + run in the page. Inert for the rest of the app (nothing else imports node: builtins).
const shimsDir = join(webRoot, "src/lib/mcp/shims");
const NODE_SHIMS: Record<string, string> = {
  "node:process": "process.ts", "node:fs": "fs.ts", "node:fs/promises": "fs-promises.ts",
  "node:crypto": "crypto.ts", "node:url": "url.ts", "node:zlib": "node-zlib.ts", // full surface incl. constants (just-bash)
};
// transformers.js has no "browser" export condition (only "node" + "default"), and Bun applies "node" →
// it bundles the Node build (sharp + onnxruntime-node), which throws at eval in a browser. Force its WEB
// build. (Verified via smoke test: without this, in-browser embeddings/ASR fail with a masked error.)
let TF_WEB: string | null = null;
try { const m = (Bun as any).resolveSync("@huggingface/transformers", import.meta.dir); TF_WEB = join(dirname(m), "..", "dist", "transformers.web.js"); } catch { /* not installed */ }
const nodeShimPlugin = {
  name: "node-shims",
  setup(build: any) {
    build.onResolve({ filter: /^node:(process|fs|fs\/promises|crypto|url|zlib)$/ }, (args: any) => {
      const file = NODE_SHIMS[args.path];
      return file ? { path: join(shimsDir, file) } : undefined;
    });
    if (TF_WEB) build.onResolve({ filter: /^@huggingface\/transformers$/ }, () => ({ path: TF_WEB }));
  },
};

function repoSlug(): { owner: string; repo: string } | null {
  const fromEnv = Bun.env.GITHUB_REPOSITORY; // "owner/repo" in Actions
  if (fromEnv?.includes("/")) { const [owner, repo] = fromEnv.split("/"); return { owner, repo }; }
  try {
    const url = Bun.spawnSync(["git", "remote", "get-url", "origin"]).stdout.toString().trim();
    const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+)/i);
    if (m) return { owner: m[1], repo: m[2] };
  } catch { /* not a git checkout */ }
  return null;
}

function resolveSite(): { origin: string; base: string } {
  // 1. custom domain via CNAME
  if (existsSync("./public/CNAME")) {
    const domain = readFileSync("./public/CNAME", "utf8").trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (domain) return { origin: "https://" + domain, base: "/" };
  }
  // 2. derive from the repo; 3. env override
  const slug = repoSlug();
  const owner = slug?.owner ?? "";
  const derivedOrigin = owner ? `https://${owner.toLowerCase()}.github.io` : "";
  const isUserSite = slug ? slug.repo.toLowerCase() === `${owner.toLowerCase()}.github.io` : false;
  const derivedBase = slug ? (isUserSite ? "/" : `/${slug.repo}/`) : "/";
  return {
    origin: (Bun.env.SITE_ORIGIN ?? derivedOrigin).replace(/\/$/, ""),
    base: Bun.env.PUBLIC_PATH ?? derivedBase,
  };
}

const resolved = resolveSite();
const origin = resolved.origin;
let base = resolved.base;
if (!base.startsWith("/")) base = "/" + base;
if (!base.endsWith("/")) base += "/";
const baseNoTrail = base === "/" ? "" : base.replace(/\/$/, ""); // "" | "/lna"
const site = origin + base;                                     // https://…/lna/
if (!origin) console.warn("⚠ could not derive SITE_ORIGIN (no CNAME, GITHUB_REPOSITORY, or git remote) — set SITE_ORIGIN");

// Optional, heavy, dynamically-imported deps (in-browser ML + sandbox). Each call site is dep-gated and
// throws a friendly message when its dep is absent. Mark the MISSING ones `external` so the bundle stays
// green without them; once a dep is installed it drops off this list and Bun bundles it → "install to
// enable" works. (Bun otherwise hard-errors on some unresolved const-folded dynamic specifiers.)
const OPTIONAL_DEPS = [
  "@huggingface/transformers", "kokoro-js", "@mlc-ai/web-llm", "sql.js",
  "isomorphic-git", "isomorphic-git/http/web", "just-bash", "just-bash/browser",
];
const isInstalled = (pkg: string): boolean => { try { (Bun as any).resolveSync(pkg, import.meta.dir); return true; } catch { return false; } };
const externalDeps = OPTIONAL_DEPS.filter((p) => !isInstalled(p));
if (externalDeps.length) console.log(`optional deps not installed (externalized): ${externalDeps.join(", ")}`);

// regenerate the lazy-skills index from ../.agents/skills so the bundle can't ship a stale one
console.log(`gen skills index: ${writeSkillsIndex()} skill(s) → src/lib/agent/skills.generated.ts`);

const result = await Bun.build({
  entrypoints: ["./index.html"],
  outdir: "./dist",
  minify: true,
  // Source maps of the bundled in-browser ML libs (transformers.js/web-llm/kokoro) are ~280MB — no place
  // in a Pages artifact. Off by default (the deploy build); opt in locally with SOURCEMAPS=1.
  sourcemap: Bun.env.SOURCEMAPS === "1" ? "linked" : "none",
  publicPath: base,
  external: externalDeps,
  plugins: [reactCompiler, tailwind, nodeShimPlugin],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

// The inference worker is its own module graph (a Worker doesn't share the page bundle). Bun's HTML build
// leaves `new Worker(new URL(...))` unbundled, so build it separately to a stable filename that
// worker-engine.ts loads at <base>/inference-worker.js. Same plugins so the node shims + transformers
// web build apply here too.
const workerBuild = await Bun.build({
  entrypoints: [join(webRoot, "..", "inference/browser.worker.ts")],
  outdir: "./dist",
  naming: "inference-worker.[ext]",
  minify: true,
  sourcemap: Bun.env.SOURCEMAPS === "1" ? "linked" : "none",
  publicPath: base,
  external: externalDeps,
  plugins: [nodeShimPlugin],
});
if (!workerBuild.success) {
  for (const log of workerBuild.logs) console.error(log);
  process.exit(1);
}

// ---- SEO block, injected before </head> so Bun never tries to bundle the icon/manifest refs ----
const seo = `
<link rel="canonical" href="${site}">
<meta name="keywords" content="AUTOMO, local AI agent, browser AI agent, Local Network Access, LNA, Ollama, OpenAI Agents SDK, SandboxAgent, local-first, on-device AI, private AI, apply_patch, MCP">
<meta name="author" content="Damion Rashford">
<meta name="application-name" content="AUTOMO">
<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1">
<meta name="googlebot" content="index, follow">
<meta name="theme-color" content="#14131a">
<meta name="color-scheme" content="dark">
<link rel="icon" href="${baseNoTrail}/favicon.svg" type="image/svg+xml">
<link rel="icon" href="${baseNoTrail}/icon-192.png" type="image/png" sizes="192x192">
<link rel="apple-touch-icon" href="${baseNoTrail}/apple-touch-icon.png" sizes="180x180">
<link rel="mask-icon" href="${baseNoTrail}/favicon.svg" color="#f5906f">
<link rel="manifest" href="${baseNoTrail}/manifest.webmanifest">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="AUTOMO">
<meta property="og:type" content="website">
<meta property="og:site_name" content="AUTOMO">
<meta property="og:title" content="AUTOMO — local-first browser AI agent">
<meta property="og:description" content="A local-first AI agent that runs in your browser and reaches the model, files, and shell on your own machine over Local Network Access. A real @openai/agents SandboxAgent.">
<meta property="og:url" content="${site}">
<meta property="og:image" content="${site}og-image.png">
<meta property="og:image:secure_url" content="${site}og-image.png">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="AUTOMO — local-first browser AI agent">
<meta property="og:locale" content="en_US">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="AUTOMO — local-first browser AI agent">
<meta name="twitter:description" content="A local-first AI agent that runs in your browser and reaches the model, files, and shell on your own machine over Local Network Access.">
<meta name="twitter:image" content="${site}og-image.png">
<meta name="twitter:image:alt" content="AUTOMO — local-first browser AI agent">
<script type="application/ld+json">${JSON.stringify({
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "AUTOMO",
  description: "A local-first AI agent that runs in your browser and talks to the model, files, and shell on your own machine over Local Network Access. A real @openai/agents SandboxAgent.",
  url: site,
  image: site + "og-image.png",
  applicationCategory: "DeveloperApplication",
  operatingSystem: "Web (Chrome 138+ with Local Network Access)",
  browserRequirements: "Requires a Chromium browser with Local Network Access and a local model (e.g. Ollama).",
  softwareVersion: "1.0",
  isAccessibleForFree: true,
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  featureList: [
    "Local-first inference over Local Network Access",
    "@openai/agents SandboxAgent in the browser",
    "Shell, filesystem/apply_patch, skills, memory, and compaction",
    "Streamable HTTP and stdio MCP servers",
    "Image understanding and image generation",
  ],
  author: { "@type": "Person", name: "Damion Rashford", url: "https://github.com/damionrashford" },
})}</script>
`.trim();

const indexPath = "./dist/index.html";
let html = await Bun.file(indexPath).text();
html = html.replace("</head>", seo + "</head>");
await Bun.write(indexPath, html);

// ---- copy public/ (robots, sitemap, manifest, icons, og-image) + substitute URL tokens ----
if (existsSync("./public")) {
  await cp("./public", "./dist", { recursive: true });
  for (const name of ["robots.txt", "sitemap.xml", "manifest.webmanifest"]) {
    const p = "./dist/" + name;
    if (existsSync(p)) {
      const text = (await Bun.file(p).text()).replaceAll("__SITE__", site).replaceAll("__BASE__", base);
      await Bun.write(p, text);
    }
  }
  console.log("copied public/ → dist/ (+ substituted __SITE__ / __BASE__)");
}

// ---- service worker: precache the app shell (base-path aware, no hardcoded URL) ----
// Only same-origin GET assets/navigations are cached — LNA/localhost, the bridge WS, CORS
// proxies, and fonts are never touched, so local inference is unaffected.
const distFiles = readdirSync("./dist");
const assetRe = /^(chunk-.*\.(js|css)|favicon\.svg|icon-\d+\.png|apple-touch-icon\.png|manifest\.webmanifest)$/;
const shell = [base, ...distFiles.filter((f) => assetRe.test(f)).map((f) => base + f)]; // base = the nav URL (index.html)
const version = (distFiles.find((f) => /^chunk-.*\.js$/.test(f)) || "v1").replace(/\W/g, "");
const sw = `// AUTOMO service worker — precache the app shell + serve background-fetched model weights (build.ts).
const CACHE = "automo-${version}";
const WEIGHTS = "automo-weights"; // model weights (cross-origin HF/CDN) pre-downloaded via Background Fetch
const SHELL = ${JSON.stringify(shell)};
const NAV_FALLBACK = ${JSON.stringify(base)};
self.addEventListener("install", (e) => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {})); });
self.addEventListener("activate", (e) => { e.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys.filter((k) => k !== CACHE && k !== WEIGHTS && k.startsWith("automo-")).map((k) => caches.delete(k)));
  await self.clients.claim();
})()); });
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;                    // never touch POSTs (model, proxy, bridge)
  const url = new URL(req.url);
  // weights cache is checked for ANY origin — this is how pre-downloaded model weights are served to the
  // in-browser ML libs (transformers.js / kokoro / web-llm) without re-downloading.
  const weighty = /\\.(onnx|onnx_data|bin|wasm|gguf|task|safetensors)(\\?|$)/i.test(url.pathname) || /huggingface\\.co|hf\\.co|mlc-ai|cdn-lfs/i.test(url.host);
  if (weighty) { e.respondWith(caches.open(WEIGHTS).then((c) => c.match(req)).then((hit) => hit || fetch(req))); return; }
  if (url.origin !== self.location.origin) return;     // never touch LNA/localhost/proxy/font requests
  if (req.mode === "navigate") {                        // SPA: network-first, fall back to cached shell
    e.respondWith(fetch(req).catch(() => caches.match(NAV_FALLBACK)));
    return;
  }
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  }).catch(() => hit)));
});
// Background Fetch: OS-level download of model weights that survives navigation/close, then cache them so
// the ML libs find them already local. matchAll() → responseReady → put into the WEIGHTS cache.
self.addEventListener("backgroundfetchsuccess", (e) => {
  e.waitUntil((async () => {
    const records = await e.registration.matchAll();
    const cache = await caches.open(WEIGHTS);
    await Promise.all(records.map(async (r) => { try { await cache.put(r.request, await r.responseReady); } catch (_) {} }));
    try { await e.updateUI({ title: "AUTOMO — model weights ready" }); } catch (_) {}
  })());
});
self.addEventListener("backgroundfetchclick", (e) => { e.waitUntil(self.clients.openWindow(NAV_FALLBACK)); });
// Best-effort autonomous drain: the SW can't run the agent (it needs the page's model), so on a background
// wake it just pokes any open client to pump its task queue. periodicSync is Chromium + installed-PWA +
// permission-gated; sync is a one-shot fallback; a message lets the page ask for an immediate broadcast.
async function drainClients() {
  const cs = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
  for (const c of cs) c.postMessage({ type: "automo-drain" });
}
self.addEventListener("periodicsync", (e) => { if (e.tag === "automo-drain") e.waitUntil(drainClients()); });
self.addEventListener("sync", (e) => { if (e.tag === "automo-drain") e.waitUntil(drainClients()); });
self.addEventListener("message", (e) => { if (e.data && e.data.type === "automo-drain-ping") e.waitUntil(drainClients()); });
`;
await Bun.write("./dist/sw.js", sw);
console.log(`wrote dist/sw.js (precache ${shell.length} entries, cache ${version})`);

console.log(`built ${result.outputs.length} files → dist/ · site ${site}`);
