// Off-main-thread host for the in-browser Pyodide sandbox. Pyodide (Python), just-bash, and isomorphic-git
// run here so shell/exec/git no longer block the UI thread. Holds one session and dispatches session
// method calls by name; the main-thread proxy (worker-client.ts) drives it. OPFS is available in workers,
// so persistence works unchanged. Built to dist/sandbox-worker.js by scripts/build.ts.
import { InBrowserSandboxSession } from "./client";
import { bootPyodide, MOUNT_PATH } from "./pyodide";

/* eslint-disable @typescript-eslint/no-explicit-any */
let session: InBrowserSandboxSession | null = null;

self.addEventListener("message", async (e: MessageEvent) => {
  const { id, op, args } = e.data ?? {};
  const post = (m: any) => (self as any).postMessage({ id, ...m });
  try {
    if (op === "ping") { post({ ok: true, result: null }); return; }
    if (op === "create") {
      const py = await bootPyodide();
      session = new InBrowserSandboxSession(py);
      if (args?.entries && Object.keys(args.entries).length) await session.applyManifest(args);
      post({ ok: true, result: { workspaceRootPath: MOUNT_PATH } });
      return;
    }
    if (!session) throw new Error("sandbox worker session not created");
    // editor.<method> targets a fresh editor (its methods close over the session's FS); everything else is
    // a direct session method taking a single argument.
    const result = op.startsWith("editor.")
      ? await (session.createEditor() as any)[op.slice(7)](args)
      : await (session as any)[op](args);
    post({ ok: true, result });
  } catch (err: any) {
    post({ ok: false, error: err?.message ?? String(err) });
  }
});
