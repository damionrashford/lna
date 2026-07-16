// In-browser sandbox — a bridge-less SandboxClient (Pyodide + just-bash + isomorphic-git over OPFS).
// Drop-in for the bridge-backed BrowserSandboxClient; the agent/tools/memory/MCP run unchanged.
export { InBrowserSandboxClient } from "./client";
export { bootPyodide, runUserCode, MOUNT_PATH } from "./pyodide";
