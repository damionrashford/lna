// Main-thread proxy for the Pyodide sandbox worker. Implements the SDK SandboxClient/SandboxSession by
// forwarding each method to the worker (sandbox.worker.ts). Two things stay on the main thread: `state`
// (read synchronously by the SDK) is a fixed mirror of the worker's root, and pre-stop hooks (registered
// with a function, so they can't cross the worker boundary) — the hooks run here and their file writes
// forward to the worker. A failed liveness ping falls back to the direct main-thread client.
import type { SandboxClient, SandboxSession } from "@openai/agents/sandbox";
import { MOUNT_PATH } from "./pyodide";
import { InBrowserSandboxClient } from "./client";
import { logEvent } from "../../../store";

/* eslint-disable @typescript-eslint/no-explicit-any */
const WORKER_URL = new URL("sandbox-worker.js", import.meta.url);
let worker: Worker | null = null;
function getWorker(): Worker {
  if (!worker) worker = new Worker(WORKER_URL, { type: "module" });
  return worker;
}

let seq = 0;
function rpc<T = any>(op: string, args?: any): Promise<T> {
  const w = getWorker();
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    const onMsg = (e: MessageEvent) => {
      const d: any = e.data;
      if (d?.id !== id) return;
      w.removeEventListener("message", onMsg);
      d.ok ? resolve(d.result) : reject(new Error(d.error));
    };
    w.addEventListener("message", onMsg);
    w.postMessage({ id, op, args });
  });
}

async function ping(timeoutMs = 10000): Promise<void> {
  await Promise.race([
    rpc("ping"),
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error("sandbox worker ping timeout")), timeoutMs)),
  ]);
}

class WorkerSandboxSession implements SandboxSession<any> {
  state = { workspaceRootPath: MOUNT_PATH, environment: {}, exposedPorts: {}, workspaceReady: true };
  private _preStop: Array<() => Promise<void> | void> = [];

  supportsPty = () => false;
  writeStdin = async (): Promise<string> => { throw new Error("interactive stdin isn't supported in the in-browser sandbox"); };

  exec = (a: any) => rpc("exec", a);
  execCommand = (a: any) => rpc<string>("execCommand", a);
  readFile = (a: any) => rpc<Uint8Array>("readFile", a);
  listDir = (a: any) => rpc("listDir", a);
  pathExists = (path: string) => rpc<boolean>("pathExists", path);
  viewImage = (a: any) => rpc("viewImage", a);
  materializeEntry = (a: any) => rpc<void>("materializeEntry", a);
  applyManifest = (a: any) => rpc<void>("applyManifest", a);
  persistWorkspace = () => rpc<Uint8Array>("persistWorkspace");
  hydrateWorkspace = (d: any) => rpc<void>("hydrateWorkspace", d);
  runPython = (code: string) => rpc("runPython", code);

  createEditor = () => ({
    createFile: (op: any) => rpc("editor.createFile", op),
    updateFile: (op: any) => rpc("editor.updateFile", op),
    deleteFile: (op: any) => rpc("editor.deleteFile", op),
  });

  registerPreStopHook = (h: () => Promise<void> | void) => { this._preStop.push(h); return () => { this._preStop = this._preStop.filter((x) => x !== h); }; };
  runPreStopHooks = async () => { for (const h of this._preStop) { try { await h(); } catch { /* best-effort flush */ } } };
  close = async () => { await rpc("close").catch(() => {}); };
}

export class WorkerSandboxClient implements SandboxClient<any, any> {
  backendId = "in-browser-pyodide-worker";
  create = async (args?: any): Promise<any> => {
    try {
      await ping();
    } catch (e: any) {
      logEvent("warn", "sandbox worker unavailable; running Pyodide on the main thread: " + (e?.message ?? e));
      return new InBrowserSandboxClient().create(args);
    }
    const manifest = args?.manifest ?? args;
    await rpc("create", manifest);
    return new WorkerSandboxSession();
  };
}
