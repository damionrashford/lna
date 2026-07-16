// isomorphic-git over the same Pyodide FS — so `materializeEntry({ gitRepo })` clones a repo into the
// in-browser workspace (the bridge does this natively; here we do it in the page). Ported from
// gh-pages-react/src/lib/gitfs.ts, trimmed to the clone path. isomorphic-git + its web http client are
// dep-gated dynamic imports so nothing bundles until the in-browser sandbox is selected.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { persist } from "./pyodide";

const CORS_PROXY = "https://cors.isomorphic-git.org"; // clone against hosts without permissive CORS

type Errno = Error & { code: string };
function errno(code: string, msg: string): Errno { const e = new Error(msg) as Errno; e.code = code; return e; }

// isomorphic-git wants an fs with the {promises:{readFile,writeFile,unlink,readdir,mkdir,rmdir,stat,
// lstat,readlink,symlink,chmod}} shape and Node-style errno codes — build it straight from Emscripten FS.
function makeGitFs(FS: any) {
  const exists = (p: string): boolean => { try { return FS.analyzePath(p).exists; } catch { return false; } };
  const wrapStat = (s: any) => {
    const mtimeMs = s.mtime instanceof Date ? s.mtime.getTime() : 0;
    return {
      mode: s.mode, size: s.size, ino: s.ino ?? 0, dev: s.dev ?? 1, uid: 1, gid: 1, mtimeMs,
      ctimeMs: s.ctime instanceof Date ? s.ctime.getTime() : mtimeMs,
      isFile: () => FS.isFile(s.mode), isDirectory: () => FS.isDir(s.mode), isSymbolicLink: () => FS.isLink(s.mode),
    };
  };
  const promises = {
    async readFile(path: string, opts?: any) {
      if (!exists(path)) throw errno("ENOENT", `ENOENT: ${path}`);
      const enc = typeof opts === "string" ? opts : opts?.encoding;
      return enc === "utf8" ? FS.readFile(path, { encoding: "utf8" }) : FS.readFile(path, { encoding: "binary" });
    },
    async writeFile(path: string, data: string | Uint8Array) {
      const parent = path.slice(0, path.lastIndexOf("/"));
      if (parent && !exists(parent)) FS.mkdirTree(parent);
      FS.writeFile(path, data);
    },
    async unlink(path: string) { if (!exists(path)) throw errno("ENOENT", `ENOENT: ${path}`); FS.unlink(path); },
    async readdir(path: string) { if (!exists(path)) throw errno("ENOENT", `ENOENT: ${path}`); return (FS.readdir(path) as string[]).filter((n) => n !== "." && n !== ".."); },
    async mkdir(path: string) { if (exists(path)) throw errno("EEXIST", `EEXIST: ${path}`); FS.mkdirTree(path); },
    async rmdir(path: string) { if (!exists(path)) throw errno("ENOENT", `ENOENT: ${path}`); FS.rmdir(path); },
    async stat(path: string) { if (!exists(path)) throw errno("ENOENT", `ENOENT: ${path}`); return wrapStat(FS.stat(path)); },
    async lstat(path: string) { if (!exists(path)) throw errno("ENOENT", `ENOENT: ${path}`); return wrapStat(FS.lstat(path)); },
    async readlink(path: string) { if (!exists(path)) throw errno("ENOENT", `ENOENT: ${path}`); return FS.readlink(path); },
    async symlink(target: string, path: string) { FS.symlink(target, path); },
    async chmod(path: string, mode: number) { FS.chmod(path, mode); },
  };
  return { promises };
}

// Clone `url` into `dir` (a path in the Pyodide FS), shallow + single-branch, then persist to OPFS.
export async function gitClone(pyodide: any, url: string, dir: string, ref?: string): Promise<void> {
  const git: any = (await import("isomorphic-git").catch(() => {
    throw new Error("In-browser git needs `isomorphic-git` — add it to clone repos in the page.");
  })).default;
  const http: any = (await import("isomorphic-git/http/web")).default;
  await git.clone({ fs: makeGitFs(pyodide.FS), http, dir, url, ref, corsProxy: CORS_PROXY, singleBranch: true, depth: 1 });
  await persist();
}
