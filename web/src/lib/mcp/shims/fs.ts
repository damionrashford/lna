// node:fs shim — a lazy, synchronous, HTTP-backed read-only fs. A bundled server does
// readFileSync(<synthetic path>); we map that path to a served URL and fetch it SYNCHRONOUSLY (the
// x-user-defined charset trick lets sync XHR return binary on the main thread), cache it, and return a
// Buffer. Writes go to an in-memory cache. The path→URL map is injected via globalThis.__fsMap.
// Ported from gh-pages-react/shims.
import { Buffer } from "buffer";

/* eslint-disable @typescript-eslint/no-explicit-any */
const cache = new Map<string, Buffer>();
const missing = new Set<string>();

function norm(p: any): string { let s = String(p).replace(/\\/g, "/"); if (!s.startsWith("/")) s = "/" + s; return s.replace(/\/+/g, "/"); }
function toUrl(p: string): string | null {
  const map: Record<string, string> = (globalThis as any).__fsMap ?? {};
  for (const prefix of Object.keys(map)) if (p.startsWith(prefix)) return map[prefix] + p.slice(prefix.length);
  return null;
}
function syncFetch(url: string): Buffer | null {
  try {
    const x = new XMLHttpRequest();
    x.open("GET", url, false); // synchronous
    x.overrideMimeType("text/plain; charset=x-user-defined");
    x.send();
    if (x.status < 200 || x.status >= 300) return null;
    const t = x.responseText; const b = Buffer.alloc(t.length);
    for (let i = 0; i < t.length; i++) b[i] = t.charCodeAt(i) & 0xff;
    return b;
  } catch { return null; }
}
function load(p: string): Buffer | null {
  const key = norm(p);
  if (cache.has(key)) return cache.get(key)!;
  if (missing.has(key)) return null;
  const url = toUrl(key);
  const buf = url ? syncFetch(url) : null;
  if (buf) { cache.set(key, buf); return buf; }
  missing.add(key); return null;
}

export function readFileSync(p: any, opts?: any): any {
  const buf = load(p);
  if (!buf) { const e: any = new Error(`ENOENT: no such file '${p}'`); e.code = "ENOENT"; throw e; }
  const enc = typeof opts === "string" ? opts : opts?.encoding;
  return enc ? buf.toString(enc) : buf;
}
export function existsSync(p: any): boolean { return !!load(p); }
export function readdirSync(_p: any): string[] { const manifest: Record<string, string[]> = (globalThis as any).__fsDirs ?? {}; return manifest[norm(_p)] ?? []; }
export function statSync(p: any): any {
  const buf = load(p);
  if (!buf) { const e: any = new Error(`ENOENT: ${p}`); e.code = "ENOENT"; throw e; }
  return { size: buf.length, isFile: () => true, isDirectory: () => false, mtimeMs: 0, mtime: new Date(0) };
}
export function writeFileSync(p: any, data: any) { cache.set(norm(p), Buffer.isBuffer(data) ? data : Buffer.from(data)); }
export function mkdirSync() {}
export function realpathSync(p: any) { return norm(p); }

export const promises = {
  async readFile(p: any, opts?: any) { return readFileSync(p, opts); },
  async access(p: any) { if (!load(p)) { const e: any = new Error(`ENOENT: ${p}`); e.code = "ENOENT"; throw e; } },
  async readdir(p: any) { return readdirSync(p); },
  async stat(p: any) { return statSync(p); },
  async writeFile(p: any, d: any) { writeFileSync(p, d); },
  async mkdir() {},
};

export default { readFileSync, existsSync, readdirSync, statSync, writeFileSync, mkdirSync, realpathSync, promises };
