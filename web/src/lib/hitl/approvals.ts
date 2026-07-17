// Human-in-the-loop registry — one surface for two kinds of pending user input:
//   - "approval": an SDK tool call paused on needsApproval (approve / reject).
//   - "elicitation": an MCP server requesting structured input mid-tool-call, with a JSON-Schema form
//     (accept + content / decline / cancel).
// A pending item resolves via a stored Promise, so a tool call can pause and later resume in one stream.
// The transport / MCP client await these; the UI (Approvals.tsx) renders them and resolves.
import { useSyncExternalStore } from "react";
import { setBadge } from "../platform/badge";

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface PendingItem {
  id: string;
  kind: "approval" | "elicitation";
  name: string;
  args?: string;        // approval: tool-args preview
  message?: string;     // elicitation: the server's prompt
  schema?: any;         // elicitation: requestedSchema (JSON Schema of primitives)
}
export interface ApprovalDecision { approved: boolean; message?: string }
export interface ElicitResult { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> }

let pending: PendingItem[] = [];
const resolvers = new Map<string, (v: any) => void>();
const listeners = new Set<() => void>();
const emit = () => { setBadge(pending.length); listeners.forEach((l) => l()); };

// ---- tool approval (SDK interruptions) ----
export function requestApproval(p: { id: string; name: string; args: string }): Promise<ApprovalDecision> {
  return new Promise((resolve) => {
    resolvers.set(p.id, resolve);
    pending = [...pending, { id: p.id, kind: "approval", name: p.name, args: p.args }];
    emit();
  });
}
export function resolveApproval(id: string, approved: boolean, message?: string) {
  const r = resolvers.get(id); if (!r) return;
  resolvers.delete(id); pending = pending.filter((x) => x.id !== id); emit();
  r({ approved, message });
}

// ---- MCP elicitation ----
export function requestElicitation(server: string, params: any): Promise<ElicitResult> {
  const id = "elicit-" + Math.random().toString(36).slice(2, 10);
  return new Promise((resolve) => {
    resolvers.set(id, resolve);
    pending = [...pending, { id, kind: "elicitation", name: `${server} · input request`, message: params?.message, schema: params?.requestedSchema }];
    emit();
  });
}
export function resolveElicitation(id: string, action: ElicitResult["action"], content?: Record<string, unknown>) {
  const r = resolvers.get(id); if (!r) return;
  resolvers.delete(id); pending = pending.filter((x) => x.id !== id); emit();
  r({ action, content: action === "accept" ? content ?? {} : undefined });
}

export function getPending(): PendingItem[] { return pending; }
function subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }
export function useApprovals(): PendingItem[] { return useSyncExternalStore(subscribe, getPending, getPending); }
