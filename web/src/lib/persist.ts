// Workspace linkage — connects the REAL sandbox workspace (hosted by the bridge, on the machine's
// disk) to two browser-side stores, over the SDK's persist/hydrate + exec/readFile seam:
//   1. OPFS — a gzip'd tar cached per session, so the sandbox survives reloads without a snapshot
//      ritual (durable, invisible). Uses the Compression Streams API; no dependencies.
//   2. a granted folder (File System Access) — a live mirror of the workspace files onto real disk,
//      so you can open and edit what the agent made in Finder. Written under <folder>/workspace/.
// OPFS is browser-origin-private (never touches real disk); the folder is the only real-disk path.
import { opfsRoot, resolvePath, getFsRoot, walk } from "./opfs";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---- gzip via the Compression Streams API (stable, worker-safe, no deps) ----
async function gzip(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("gzip");
  const stream = new Blob([data as any]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("gzip");
  const stream = new Blob([data as any]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ---- OPFS byte I/O ----
async function opfsPutBytes(path: string, bytes: Uint8Array) {
  const { dir, file } = await resolvePath(await opfsRoot(), path, true);
  const fh = await dir.getFileHandle(file, { create: true });
  const w = await fh.createWritable(); await w.write(bytes as any); await w.close();
}
async function opfsGetBytes(path: string): Promise<Uint8Array | null> {
  try {
    const { dir, file } = await resolvePath(await opfsRoot(), path);
    const f = await (await dir.getFileHandle(file)).getFile();
    return new Uint8Array(await f.arrayBuffer());
  } catch { return null; }
}

const cachePath = (sid: string) => `workspaces/${sid}.tar.gz`;

// Ask the browser to keep OPFS/IndexedDB from being evicted under storage pressure.
// (StorageManager.persist — secure-context; best-effort, some browsers auto-grant.)
export async function requestDurable(): Promise<boolean> {
  try {
    if (await navigator.storage?.persisted?.()) return true;
    return (await navigator.storage?.persist?.()) ?? false;
  } catch { return false; }
}

// persist the live sandbox workspace → gzip'd tar in OPFS, keyed by session id.
export async function cacheWorkspace(sid: string, session: any): Promise<void> {
  if (!sid || !session?.persistWorkspace) return;
  try {
    const tar: Uint8Array = await session.persistWorkspace();
    if (tar?.length) await opfsPutBytes(cachePath(sid), await gzip(tar));
  } catch { /* best-effort — bridge may be down or workspace empty */ }
}

// hydrate a fresh sandbox session from this session's OPFS cache, if any. Returns true if applied.
export async function hydrateWorkspaceFromCache(sid: string, session: any): Promise<boolean> {
  if (!sid || !session?.hydrateWorkspace) return false;
  try {
    const gz = await opfsGetBytes(cachePath(sid));
    if (!gz) return false;
    await session.hydrateWorkspace(await gunzip(gz));
    return true;
  } catch { return false; }
}

export async function dropWorkspaceCache(sid: string): Promise<void> {
  try { const { dir, file } = await resolvePath(await opfsRoot(), cachePath(sid)); await dir.removeEntry(file); } catch { /* nothing cached */ }
}

// Mirror the live sandbox workspace onto the granted folder, under <folder>/workspace/, so the
// agent's files are visible/editable on real disk. One-way (sandbox → folder), best-effort, capped.
const MIRROR_SUBDIR = "workspace";
const MIRROR_MAX_FILES = 2000;

// Suppress the folder observer while WE are writing the mirror, so exporting doesn't trigger an
// import that re-triggers an export (feedback loop). performance.now() is monotonic and cheap.
let suppressObserverUntil = 0;
const suppressed = () => performance.now() < suppressObserverUntil;

export async function mirrorToFolder(session: any): Promise<number> {
  const root = getFsRoot();
  if (!root || !session?.exec || !session?.readFile) return 0;
  suppressObserverUntil = performance.now() + 2000;
  const wsRoot = (session.state?.workspaceRootPath || ".").replace(/\/$/, "");
  let rels: string[] = [];
  try {
    const res = await session.exec({
      cmd: `find . -type f -not -path './.git/*' -not -path './node_modules/*' | head -${MIRROR_MAX_FILES}`,
      workdir: wsRoot,
    });
    rels = String(res?.stdout || "").split("\n").map((s) => s.replace(/^\.\//, "").trim()).filter(Boolean);
  } catch { return 0; }
  // Prune the previous mirror so files the agent deleted don't linger on disk — the folder should
  // track the workspace, not accumulate. removeEntry(recursive) is a no-op the first time.
  try { await (root as any).removeEntry(MIRROR_SUBDIR, { recursive: true }); } catch { /* nothing to prune */ }
  let n = 0;
  for (const rel of rels) {
    try {
      const bytes = await session.readFile({ path: wsRoot + "/" + rel });
      const u8 = bytes instanceof Uint8Array ? bytes : new TextEncoder().encode(String(bytes));
      const { dir, file } = await resolvePath(root, MIRROR_SUBDIR + "/" + rel, true);
      const fh = await dir.getFileHandle(file, { create: true });
      const w = await fh.createWritable(); await w.write(u8 as any); await w.close();
      n++;
    } catch { /* skip unreadable entry */ }
  }
  return n;
}

const tryUtf8 = (buf: Uint8Array): string | null => {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { return null; }
};

// Import the folder's <folder>/workspace/ mirror back INTO the sandbox: text files become inline
// `file` manifest entries via materializeEntry (JSON-safe over the bridge). Binary is skipped (it
// can't cross the JSON WebSocket). Best-effort; returns the number of files written.
export async function importFromFolder(session: any): Promise<number> {
  const root = getFsRoot();
  if (!root || !session?.materializeEntry) return 0;
  let sub: any;
  try { sub = await (root as any).getDirectoryHandle(MIRROR_SUBDIR); } catch { return 0; }
  let n = 0;
  for await (const { path, handle } of walk(sub)) {
    if (n >= MIRROR_MAX_FILES) break;
    try {
      const buf = new Uint8Array(await (await handle.getFile()).arrayBuffer());
      const text = tryUtf8(buf);
      if (text == null) continue; // binary — skip
      await session.materializeEntry({ path, entry: { type: "file", content: text } });
      n++;
    } catch { /* skip */ }
  }
  return n;
}

// FileSystemObserver — auto-import external edits to the granted folder back into the sandbox.
// EXPERIMENTAL, non-standard, Chromium-only: feature-detected and entirely optional. The suppression
// window keeps our own mirror writes from triggering an import→export feedback loop.
let observer: any = null;
export function startFolderObserver(session: any): void {
  const root = getFsRoot();
  const Ctor = (globalThis as any).FileSystemObserver;
  if (!root || !Ctor || observer) return;
  let timer: any = null;
  try {
    observer = new Ctor((records: any[]) => {
      if (suppressed() || !records?.length) return;
      clearTimeout(timer);
      timer = setTimeout(() => importFromFolder(session), 400); // debounce edit bursts
    });
    observer.observe(root, { recursive: true });
  } catch { observer = null; }
}
export function stopFolderObserver(): void {
  try { observer?.disconnect?.(); } catch { /* noop */ }
  observer = null;
}
