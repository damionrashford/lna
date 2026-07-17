// InBrowserSandboxClient — a second SandboxClient (the first is the bridge-backed one in ../index.ts)
// that implements the same SDK SandboxClient/SandboxSession/Editor interfaces entirely in the browser:
//   exec/execCommand → just-bash over the Pyodide FS   filesystem CRUD → Emscripten FS + applyDiff (V4A)
//   materializeEntry(gitRepo) → isomorphic-git clone    persist/hydrate → OPFS (durable) + a JSON archive
// This runs the agent with no bridge daemon. Weaker than the bridge (just-bash is a JS bash, Pyodide is
// sandboxed, no native binaries, no real host files), but zero-install.
import type { SandboxClient, SandboxSession } from "@openai/agents/sandbox";
import { applyDiff } from "@openai/agents-core";
import { bootPyodide, persist, runUserCode, MOUNT_PATH } from "./pyodide";
import { makePyodideFs, normalize } from "./fs";
import { gitClone } from "./git";
import { u8ToB64 } from "../index";

/* eslint-disable @typescript-eslint/no-explicit-any */
const abs = (p: string) => (p.startsWith("/") ? normalize(p) : normalize(MOUNT_PATH + "/" + p));
const b64ToU8 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export class InBrowserSandboxSession implements SandboxSession<any> {
  state = { workspaceRootPath: MOUNT_PATH, environment: {}, exposedPorts: {}, workspaceReady: true };
  private _preStop: Array<() => Promise<void> | void> = [];
  constructor(private py: any) {}
  private get FS() { return this.py.FS; }
  private ensureParent(p: string) { const d = p.slice(0, p.lastIndexOf("/")); if (d && !this.FS.analyzePath(d).exists) this.FS.mkdirTree(d); }

  supportsPty = () => false;
  writeStdin = async (): Promise<string> => { throw new Error("interactive stdin isn't supported in the in-browser sandbox"); };

  exec = async ({ cmd, workdir }: any) => {
    const { Bash } = (await import("just-bash/browser").catch(() => {
      throw new Error("In-browser shell needs `just-bash` — add it to run bash in the page.");
    })) as any;
    const t0 = performance.now();
    const r = await new Bash({ fs: makePyodideFs(this.py), cwd: workdir || MOUNT_PATH }).exec(cmd);
    await persist();
    const stdout = r.stdout ?? "", stderr = r.stderr ?? "";
    return { output: stdout + stderr, stdout, stderr, exitCode: r.exitCode ?? 0, wallTimeSeconds: (performance.now() - t0) / 1000 };
  };
  execCommand = async (args: any): Promise<string> => { const r = await this.exec(args); return r.stdout + (r.stderr ? "\n" + r.stderr : ""); };

  readFile = async ({ path, maxBytes }: any): Promise<Uint8Array> => {
    const u8 = this.FS.readFile(abs(path), { encoding: "binary" }) as Uint8Array;
    return maxBytes ? u8.slice(0, maxBytes) : u8;
  };
  listDir = async ({ path }: any) => {
    const p = abs(path);
    return (this.FS.readdir(p) as string[]).filter((n) => n !== "." && n !== "..").map((name) => {
      const full = normalize(p + "/" + name); const m = this.FS.stat(full).mode;
      return { name, path: full, type: this.FS.isDir(m) ? "dir" : this.FS.isFile(m) ? "file" : "other" };
    }) as any;
  };
  pathExists = async (path: string): Promise<boolean> => !!this.FS.analyzePath(abs(path)).exists;
  viewImage = async ({ path }: any) => {
    const u8 = this.FS.readFile(abs(path), { encoding: "binary" }) as Uint8Array;
    const ext = (path.split(".").pop() || "png").toLowerCase();
    return { type: "image", image: `data:image/${ext};base64,${u8ToB64(u8)}` } as any;
  };

  materializeEntry = async ({ path, entry }: any): Promise<void> => {
    const target = abs(path);
    if (entry?.type === "git_repo") {
      const url = `https://${entry.host}/${entry.repo}${/\.git$/.test(entry.repo) ? "" : ".git"}`;
      await gitClone(this.py, url, target, entry.ref);
    } else if (entry?.type === "file") {
      this.ensureParent(target); this.FS.writeFile(target, entry.contents ?? entry.content ?? entry.text ?? ""); await persist();
    } else if (entry?.type === "dir") { this.FS.mkdirTree(target); await persist(); }
    else throw new Error(`in-browser sandbox can't materialize entry type "${entry?.type}"`);
  };
  applyManifest = async (manifest: any): Promise<void> => {
    const entries = manifest?.entries ?? manifest?.manifest?.entries ?? {};
    for (const [p, e] of Object.entries(entries)) await this.materializeEntry({ path: p, entry: e });
  };

  createEditor = () => {
    const write = (p: string, c: string) => { this.ensureParent(p); this.FS.writeFile(p, c); };
    const read = (p: string) => (this.FS.analyzePath(p).exists ? new TextDecoder().decode(this.FS.readFile(p, { encoding: "binary" })) : "");
    return {
      createFile: async (op: any) => { write(abs(op.path), applyDiff("", op.diff, "create")); await persist(); return { status: "completed" }; },
      updateFile: async (op: any) => {
        const p = abs(op.path); const next = applyDiff(read(p), op.diff);
        if (op.moveTo) { if (this.FS.analyzePath(p).exists) this.FS.unlink(p); write(abs(op.moveTo), next); } else write(p, next);
        await persist(); return { status: "completed" };
      },
      deleteFile: async (op: any) => { const p = abs(op.path); if (this.FS.analyzePath(p).exists) this.FS.unlink(p); await persist(); return { status: "completed" }; },
    } as any;
  };

  // OPFS already persists the workspace across reloads; persist/hydrate additionally back the SDK's
  // snapshot feature as a gzip'd JSON archive {path: base64} of the whole tree.
  persistWorkspace = async (): Promise<Uint8Array> => {
    const fs = makePyodideFs(this.py);
    const out: Record<string, string> = {};
    for (const p of fs.getAllPaths() as string[]) { try { if (this.FS.isFile(this.FS.stat(p).mode)) out[p] = u8ToB64(this.FS.readFile(p, { encoding: "binary" })); } catch { /* skip */ } }
    return gzip(new TextEncoder().encode(JSON.stringify(out)));
  };
  hydrateWorkspace = async (data: any): Promise<void> => {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const map = JSON.parse(new TextDecoder().decode(await gunzip(bytes))) as Record<string, string>;
    for (const [p, b64] of Object.entries(map)) { this.ensureParent(p); this.FS.writeFile(p, b64ToU8(b64)); }
    await persist();
  };

  registerPreStopHook = (h: () => Promise<void> | void) => { this._preStop.push(h); return () => { this._preStop = this._preStop.filter((x) => x !== h); }; };
  runPreStopHooks = async () => { for (const h of this._preStop) { try { await h(); } catch { /* best-effort flush */ } } };
  close = async () => { await persist(); };
  // Not part of the SDK interface: a run_python tool can call this directly.
  runPython = (code: string) => runUserCode(code);
}

export class InBrowserSandboxClient implements SandboxClient<any, any> {
  backendId = "in-browser-pyodide";
  create = async (args?: any): Promise<any> => {
    const py = await bootPyodide();
    const session = new InBrowserSandboxSession(py);
    const manifest = args?.manifest ?? args;
    if (manifest?.entries && Object.keys(manifest.entries).length) await session.applyManifest(manifest);
    return session;
  };
}

// gzip helpers via the native CompressionStream (same approach as sandbox/persist.ts).
async function gzip(u8: Uint8Array): Promise<Uint8Array> {
  const cs = new (globalThis as any).CompressionStream("gzip");
  return new Uint8Array(await new Response(new Blob([u8 as any]).stream().pipeThrough(cs)).arrayBuffer());
}
async function gunzip(u8: Uint8Array): Promise<Uint8Array> {
  const ds = new (globalThis as any).DecompressionStream("gzip");
  return new Uint8Array(await new Response(new Blob([u8 as any]).stream().pipeThrough(ds)).arrayBuffer());
}
