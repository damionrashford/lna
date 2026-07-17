// Bun-native visual smoke — capture screenshots of the running app with Bun.WebView (WKWebView on macOS,
// zero deps). This is a fast eyeball check, NOT a pass/fail gate; the Playwright suite is the real E2E.
// Point it at a running server:  `bun run preview`  in one shell (after a build), then
//   `bun run tests/visual-smoke.ts [url]`   → PNGs under tests/screenshots/.
// Kept intentionally tiny: Bun.WebView is a browser primitive (no assertions/retries/reporters), so it
// complements Playwright rather than replacing it.
import { join } from "node:path";
import { mkdirSync } from "node:fs";

const url = Bun.argv[2] ?? "http://localhost:4173/";
const outDir = join(import.meta.dir, "screenshots");
mkdirSync(outDir, { recursive: true });

const dismiss = "(() => { const s = document.querySelector('.ob-skip'); if (s) s.click(); return !!s; })()";
const WebView = (Bun as any).WebView; // experimental API — not yet in the type surface

async function shot(w: number, h: number, name: string) {
  const view = new WebView({ width: w, height: h });
  try {
    await view.navigate(url);
    await view.evaluate(dismiss); // drop the first-run overlay if present
    await Bun.write(join(outDir, name), await view.screenshot());
    console.log(`  ${name} (${w}x${h})`);
  } finally {
    view.close();
  }
}

console.log(`visual smoke → ${url}`);
await shot(1280, 900, "gate-desktop.png");
await shot(390, 844, "gate-mobile.png");
console.log(`wrote screenshots → ${outDir}`);
