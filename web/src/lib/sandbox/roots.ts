// MCP roots — the filesystem boundaries exposed to MCP servers via roots/list. The only root with a
// real, server-reachable path is the live sandbox workspace on the machine: the bridge runs there, so a
// filesystem MCP server spawned through the bridge can operate in it. The granted mirror folder is a
// File System Access handle with no real path, so it isn't exposed as a root.
// agent.ts sets the workspace path on session create; mcp.ts notifies connected servers on change.
export interface Root { uri: string; name: string }

let workspacePath: string | null = null;

export function setWorkspaceRoot(path: string | null): void { workspacePath = path || null; }

export function currentRoots(): Root[] {
  return workspacePath
    ? [{ uri: "file://" + workspacePath, name: "AUTOMO sandbox workspace" }]
    : [];
}
