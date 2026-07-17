// just-bash IFileSystem backed by Pyodide's (Emscripten) FS, so bash, Python, and git all operate on
// the same live files under /persist. Emscripten FS is synchronous; each method is wrapped async.
import { MOUNT_PATH } from "./pyodide";

/* eslint-disable @typescript-eslint/no-explicit-any */
function normalize(p: string): string {
  const abs = p.startsWith("/");
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") { if (out.length && out[out.length - 1] !== "..") out.pop(); else if (!abs) out.push(".."); }
    else out.push(seg);
  }
  return (abs ? "/" : "") + out.join("/") || (abs ? "/" : ".");
}
const dirname = (p: string) => { const n = normalize(p); const i = n.lastIndexOf("/"); return i <= 0 ? "/" : n.slice(0, i); };

export function makePyodideFs(pyodide: any) {
  const FS = pyodide.FS;
  const enc = new TextDecoder();
  const exists = (p: string) => !!FS.analyzePath(p).exists;
  const ensureParent = (p: string) => { const d = dirname(p); if (!exists(d)) FS.mkdirTree(d); };
  const toStat = (s: any) => ({
    isFile: FS.isFile(s.mode), isDirectory: FS.isDir(s.mode), isSymbolicLink: FS.isLink(s.mode),
    mode: s.mode, size: s.size, mtime: s.mtime instanceof Date ? s.mtime : new Date(s.mtime ?? 0),
  });
  function walk(root: string, acc: string[]) {
    if (!exists(root)) return;
    for (const name of FS.readdir(root)) {
      if (name === "." || name === "..") continue;
      const full = normalize(root + "/" + name); acc.push(full);
      if (FS.isDir(FS.stat(full).mode)) walk(full, acc);
    }
  }
  function rmRecursive(p: string) {
    const st = FS.stat(p);
    if (FS.isDir(st.mode)) { for (const name of FS.readdir(p)) if (name !== "." && name !== "..") rmRecursive(normalize(p + "/" + name)); FS.rmdir(p); }
    else FS.unlink(p);
  }
  const fs = {
    async readFile(path: string, options?: any) {
      const encoding = typeof options === "string" ? options : options?.encoding;
      const data = FS.readFile(path, { encoding: "binary" }) as Uint8Array;
      return encoding && encoding !== "utf8" && encoding !== "utf-8" ? bufToString(data, encoding) : enc.decode(data);
    },
    async readFileBuffer(path: string): Promise<Uint8Array> { return FS.readFile(path, { encoding: "binary" }); },
    async writeFile(path: string, content: string | Uint8Array) { ensureParent(path); FS.writeFile(path, content); },
    async appendFile(path: string, content: string | Uint8Array) {
      ensureParent(path);
      const prev = exists(path) ? (FS.readFile(path, { encoding: "binary" }) as Uint8Array) : new Uint8Array();
      const add = typeof content === "string" ? new TextEncoder().encode(content) : content;
      const merged = new Uint8Array(prev.length + add.length); merged.set(prev); merged.set(add, prev.length);
      FS.writeFile(path, merged);
    },
    async exists(path: string) { return exists(path); },
    async stat(path: string) { return toStat(FS.stat(path)); },
    async lstat(path: string) { return toStat(FS.lstat(path)); },
    async mkdir(path: string, options?: any) {
      if (options?.recursive) FS.mkdirTree(path);
      else { try { FS.mkdir(path); } catch (e: any) { if (!String(e).includes("EEXIST")) throw e; } }
    },
    async readdir(path: string) { return (FS.readdir(path) as string[]).filter((n) => n !== "." && n !== ".."); },
    async readdirWithFileTypes(path: string) {
      return (FS.readdir(path) as string[]).filter((n) => n !== "." && n !== "..").map((name) => {
        const st = FS.stat(normalize(path + "/" + name));
        return { name, isFile: FS.isFile(st.mode), isDirectory: FS.isDir(st.mode), isSymbolicLink: FS.isLink(st.mode) };
      });
    },
    async rm(path: string, options?: any) {
      if (!exists(path)) { if (options?.force) return; throw new Error("ENOENT: " + path); }
      if (options?.recursive) rmRecursive(path);
      else { const st = FS.stat(path); FS.isDir(st.mode) ? FS.rmdir(path) : FS.unlink(path); }
    },
    async cp(src: string, dest: string, options?: any) {
      const st = FS.stat(src);
      if (FS.isDir(st.mode)) {
        if (!options?.recursive) throw new Error("cp: -r required for directory");
        if (!exists(dest)) FS.mkdirTree(dest);
        for (const name of FS.readdir(src)) if (name !== "." && name !== "..") await fs.cp(normalize(src + "/" + name), normalize(dest + "/" + name), options);
      } else { ensureParent(dest); FS.writeFile(dest, FS.readFile(src, { encoding: "binary" })); }
    },
    async mv(src: string, dest: string) { ensureParent(dest); FS.rename(src, dest); },
    resolvePath(base: string, path: string) { return path.startsWith("/") ? normalize(path) : normalize(base.replace(/\/+$/, "") + "/" + path); },
    getAllPaths() { const acc: string[] = []; walk(MOUNT_PATH, acc); return acc; },
    async chmod(path: string, mode: number) { FS.chmod(path, mode); },
    async symlink(target: string, linkPath: string) { ensureParent(linkPath); FS.symlink(target, linkPath); },
    async link() { throw new Error("hard links not supported on this filesystem"); },
    async readlink(path: string) { return FS.readlink(path); },
    async realpath(path: string) { return normalize(path); },
    async utimes(path: string, atime: Date, mtime: Date) { FS.utime(path, atime.getTime(), mtime.getTime()); },
  };
  return fs as any;
}

function bufToString(u8: Uint8Array, encoding: string) {
  return encoding === "latin1" || encoding === "binary" ? String.fromCharCode(...u8) : new TextDecoder().decode(u8);
}
export { normalize, dirname };
