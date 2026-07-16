// node:url shim. fileURLToPath returns a synthetic path under the mapped package root so a server's
// data-dir detection (path.includes("<pkg>") && includes("dist")) resolves to a path we serve.
// Configurable via globalThis.__pkgEntry. Ported from gh-pages-react/shims.
/* eslint-disable @typescript-eslint/no-explicit-any */
export function fileURLToPath(_u: any): string { return (globalThis as any).__pkgEntry ?? "/pkg/dist/index.js"; }
export function pathToFileURL(p: string): any {
  const href = "file://" + (p.startsWith("/") ? p : "/" + p);
  return { href, pathname: p, toString() { return href; } };
}
export const URL = (globalThis as any).URL;
export const URLSearchParams = (globalThis as any).URLSearchParams;
export default { fileURLToPath, pathToFileURL, URL, URLSearchParams };
