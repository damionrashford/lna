// The id of the autonomy task currently executing on this tab (or null during interactive chat). A
// dependency-free ambient so the MCP layer can attribute a task-augmented tool call back to the
// autonomous task that triggered it: an MCP Task's status stream updates the durable autonomy task's
// progress. Set by the loop around each run; read by mcp/server.ts. One run per tab at a time (the loop
// guards re-entry), so a single module-level slot is sufficient.
let currentTaskId: string | null = null;
export function setCurrentTaskId(id: string | null): void { currentTaskId = id; }
export function getCurrentTaskId(): string | null { return currentTaskId; }
