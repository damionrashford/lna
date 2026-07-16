// Production build: bundle index.html (+ React/TSX + Tailwind + React Compiler) into static
// assets GitHub Pages can serve, then inject URL-dependent SEO + copy public/.
//
// Nothing about the site URL is hardcoded — it's derived, so a future custom domain "just works":
//   1. public/CNAME (how you set a GitHub Pages custom domain) → https://<domain>/ at the root.
//   2. else the repo itself → https://<owner>.github.io/<repo>/  (or /  for a <owner>.github.io repo),
//      read from GITHUB_REPOSITORY (CI) or `git remote get-url origin` (local).
//   3. env still overrides everything: SITE_ORIGIN and/or PUBLIC_PATH.
import tailwind from "bun-plugin-tailwind";
import { reactCompiler } from "./react-compiler-plugin";
import { cp } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";

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

const result = await Bun.build({
  entrypoints: ["./index.html"],
  outdir: "./dist",
  minify: true,
  sourcemap: "linked",
  publicPath: base,
  plugins: [reactCompiler, tailwind],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
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
const sw = `// AUTOMO service worker — precache the app shell (generated by build.ts).
const CACHE = "automo-${version}";
const SHELL = ${JSON.stringify(shell)};
const NAV_FALLBACK = ${JSON.stringify(base)};
self.addEventListener("install", (e) => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {})); });
self.addEventListener("activate", (e) => { e.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys.filter((k) => k !== CACHE && k.startsWith("automo-")).map((k) => caches.delete(k)));
  await self.clients.claim();
})()); });
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;                    // never touch POSTs (model, proxy, bridge)
  const url = new URL(req.url);
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
`;
await Bun.write("./dist/sw.js", sw);
console.log(`wrote dist/sw.js (precache ${shell.length} entries, cache ${version})`);

console.log(`built ${result.outputs.length} files → dist/ · site ${site}`);
