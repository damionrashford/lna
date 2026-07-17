// In-browser sandbox — a bridge-less SandboxClient (Pyodide + just-bash + isomorphic-git over OPFS).
// Drop-in for the bridge-backed BrowserSandboxClient; agent, tools, memory, and MCP run unchanged.
export { InBrowserSandboxClient } from "./client";
export { WorkerSandboxClient } from "./worker-client";
export { bootPyodide, runUserCode, MOUNT_PATH } from "./pyodide";
