import { useApprovals, resolveApproval } from "../lib/approvals";

// Human-in-the-loop: renders tool calls the run paused on. Approve/reject resolves the transport's
// awaited decision, which then approves/rejects on the RunState and resumes streaming.
export default function Approvals() {
  const pending = useApprovals();
  if (!pending.length) return null;
  return (
    <>
      {pending.map((p) => (
        <div key={p.id} className="approve">
          <div className="at">Run <b>{p.name}</b>?<span className="aa">{(p.args || "").slice(0, 140)}</span></div>
          <div className="ab">
            <button className="ay" onClick={() => resolveApproval(p.id, true)}>Approve</button>
            <button className="an" onClick={() => resolveApproval(p.id, false, "The user rejected this tool call. Continue without it.")}>Reject</button>
          </div>
        </div>
      ))}
    </>
  );
}
