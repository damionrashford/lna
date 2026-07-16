// File tools: File System Access (a granted folder = local-bind mount) + OPFS (private memory).
// The FSA permission/iterator APIs aren't all in lib.dom yet, so a few casts to `any`.
import { idbGet, idbSet } from "./idb";
import { setCap, set } from "../store";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Dir = any; // FileSystemDirectoryHandle
type FileEnt = { path: string; handle: any };

let fsRoot: Dir | null = null;   // granted directory handle
let pendingFs: Dir | null = null; // restored handle awaiting a re-grant gesture

export const getFsRoot = () => fsRoot;
export const fsName = () => (fsRoot ? fsRoot.name : pendingFs ? "click to re-grant" : "none");

export function globToRe(g: string): RegExp {
  let out = "", i = 0;
  while (i < g.length) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") { i += 2; if (g[i] === "/") { out += "(?:.*/)?"; i++; } else out += ".*"; }
    else if (c === "*") { out += "[^/]*"; i++; }
    else if (c === "?") { out += "."; i++; }
    else { out += (".+^${}()|[]\\".indexOf(c) >= 0 ? "\\" : "") + c; i++; }
  }
  return new RegExp("^" + out + "$");
}

export async function* walk(dir: Dir, prefix = ""): AsyncGenerator<FileEnt> {
  for await (const [name, h] of dir.entries()) {
    const path = prefix ? prefix + "/" + name : name;
    if (h.kind === "file") yield { path, handle: h };
    else yield* walk(h, path);
  }
}

export async function resolvePath(root: Dir, path: string, create = false): Promise<{ dir: Dir; file: string }> {
  const parts = path.split("/").filter(Boolean);
  const file = parts.pop()!;
  let dir = root;
  for (const p of parts) dir = await dir.getDirectoryHandle(p, { create });
  return { dir, file };
}

export const opfsRoot = (): Promise<Dir> => navigator.storage.getDirectory();

export async function opfsWriteFile(path: string, content: string) {
  const { dir, file } = await resolvePath(await opfsRoot(), path, true);
  const fh = await dir.getFileHandle(file, { create: true });
  const w = await fh.createWritable(); await w.write(content ?? ""); await w.close();
}
export async function opfsReadFile(path: string): Promise<string> {
  const { dir, file } = await resolvePath(await opfsRoot(), path);
  return await (await (await dir.getFileHandle(file)).getFile()).text();
}

// mirror OPFS memory into the granted folder (.automo/memory/) so it's durable + visible on disk
export async function mirrorMem(path: string, content: string) {
  if (!fsRoot) return;
  try {
    const { dir, file } = await resolvePath(fsRoot, ".automo/memory/" + path, true);
    const fh = await dir.getFileHandle(file, { create: true });
    const w = await fh.createWritable(); await w.write(content ?? ""); await w.close();
  } catch { /* best-effort */ }
}

// large tool outputs are spilled to OPFS instead of the context window; model reads back with mem_read(offset,limit)
const SPILL_CHARS = 6000; let _spillN = 0;
export async function maybeSpill(toolName: string, output: unknown): Promise<{ text: string; spilled: { path: string; size: number } | null }> {
  const s = typeof output === "string" ? output : JSON.stringify(output);
  if (s.length <= SPILL_CHARS) return { text: s, spilled: null };
  const path = "tool-outputs/" + toolName.replace(/[^a-z0-9_-]/gi, "_") + "-" + (++_spillN) + ".txt";
  try { await opfsWriteFile(path, s); } catch { /* keep going */ }
  const preview = s.slice(0, 1500);
  return {
    spilled: { path, size: s.length },
    text: `[Large output — ${s.length} chars saved to memory as "${path}". Read specific parts with mem_read({path:"${path}", offset, limit}); don't ask for the whole thing. Preview:]\n\n${preview}\n… (${s.length - 1500} more chars)`,
  };
}

function updateFsUI() {
  set({ fsName: fsName() });
  setCap("files", fsRoot ? "ok" : "", fsRoot ? "granted" : "opt-in");
}

export async function grantFolder() {
  if (pendingFs) {
    if ((await pendingFs.requestPermission({ mode: "readwrite" })) === "granted") {
      fsRoot = pendingFs; pendingFs = null; return updateFsUI();
    }
  }
  try {
    fsRoot = await (window as any).showDirectoryPicker({ mode: "readwrite" });
    await idbSet("fsRoot", fsRoot); updateFsUI();
  } catch { /* user cancelled */ }
}

export async function restoreFolder() {
  try {
    const h = await idbGet<Dir>("fsRoot"); if (!h) return;
    if ((await h.queryPermission({ mode: "readwrite" })) === "granted") fsRoot = h;
    else pendingFs = h;
    updateFsUI();
  } catch { /* no stored handle */ }
}
