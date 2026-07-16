// Human-in-the-loop approval registry. The transport's interruption loop calls requestApproval()
// and awaits the user's decision; the UI renders pending approvals (useApprovals) and resolves
// them with resolveApproval(). Bridges the SDK's run-pause to a React approve/reject surface.
import { useSyncExternalStore } from "react";

export interface PendingApproval { id: string; name: string; args: string }
export interface ApprovalDecision { approved: boolean; message?: string }

let pending: PendingApproval[] = [];
const resolvers = new Map<string, (d: ApprovalDecision) => void>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function requestApproval(p: PendingApproval): Promise<ApprovalDecision> {
  return new Promise((resolve) => { resolvers.set(p.id, resolve); pending = [...pending, p]; emit(); });
}
export function resolveApproval(id: string, approved: boolean, message?: string) {
  const r = resolvers.get(id); if (!r) return;
  resolvers.delete(id); pending = pending.filter((x) => x.id !== id); emit();
  r({ approved, message });
}
export function getPending(): PendingApproval[] { return pending; }
function subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }
export function useApprovals(): PendingApproval[] { return useSyncExternalStore(subscribe, getPending, getPending); }
