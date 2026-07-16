// Pyodide singleton for the in-browser sandbox — real Python + a persistent OPFS filesystem at /persist,
// the SAME FS just-bash and isomorphic-git operate on. Ported from gh-pages-react/src/pyodide.ts. Loaded
// from the pinned jsDelivr CDN via a variable-specifier dynamic import, so nothing bundles until the
// in-browser sandbox is actually selected.
/* eslint-disable @typescript-eslint/no-explicit-any */
const PYODIDE_VERSION = "v0.28.3";
const CDN = `https://cdn.jsdelivr.net/pyodide/${PYODIDE_VERSION}/full/`;
export const MOUNT_PATH = "/persist";

let booting: Promise<any> | null = null;
let nativefs: { syncfs: () => Promise<void> } | null = null;

const CAPTURE = `
import io, contextlib, traceback
from pyodide.code import eval_code_async
_USER_NS = {}
async def __run_capture(code):
    out, err = io.StringIO(), io.StringIO()
    rc, result = 0, None
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            result = await eval_code_async(code, globals=_USER_NS)
        except SystemExit as e:
            rc = int(e.code) if isinstance(e.code, int) else (0 if e.code is None else 1)
        except BaseException:
            traceback.print_exc(); rc = 1
    return {"stdout": out.getvalue(), "stderr": err.getvalue(), "exit": rc,
            "result": None if result is None else repr(result)}
`;

export function bootPyodide(): Promise<any> {
  if (booting) return booting;
  booting = (async () => {
    const mod = await import(/* @vite-ignore */ `${CDN}pyodide.mjs`);
    const pyodide = await mod.loadPyodide({ indexURL: CDN });
    try {
      const root = await navigator.storage.getDirectory();
      nativefs = await pyodide.mountNativeFS(MOUNT_PATH, root);
      try { pyodide.FS.chdir(MOUNT_PATH); } catch { /* default cwd */ }
    } catch { /* OPFS optional — falls back to in-memory MEMFS */ }
    await pyodide.loadPackage("micropip");
    await pyodide.runPythonAsync("import sys\nif '/persist' not in sys.path: sys.path.append('/persist')");
    await pyodide.runPythonAsync(CAPTURE);
    return pyodide;
  })();
  return booting;
}

// syncfs the OPFS mount so the workspace survives reloads (OPFS IS the durable store here).
export async function persist(): Promise<void> { if (nativefs) await nativefs.syncfs(); }

export async function runUserCode(code: string): Promise<{ stdout: string; stderr: string; exit: number; result: string | null }> {
  const py = await bootPyodide();
  try { await py.loadPackagesFromImports(code); } catch { /* pure-python / unknown imports */ }
  py.globals.set("__code", code);
  const proxy = await py.runPythonAsync("await __run_capture(__code)");
  const res = proxy.toJs({ dict_converter: Object.fromEntries });
  proxy.destroy();
  return res;
}
