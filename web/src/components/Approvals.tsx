import { useState } from "react";
import { useApprovals, resolveApproval, resolveElicitation, type PendingItem } from "../lib/approvals";

/* eslint-disable @typescript-eslint/no-explicit-any */

// Renders a JSON-Schema (primitive) elicitation request as a real form → accept(content)/decline/cancel.
function ElicitationForm({ item }: { item: PendingItem }) {
  const props: Record<string, any> = item.schema?.properties ?? {};
  const required: string[] = item.schema?.required ?? [];
  const [values, setValues] = useState<Record<string, any>>(() => {
    const init: Record<string, any> = {};
    for (const [k, p] of Object.entries(props)) init[k] = p.default ?? (p.type === "boolean" ? false : "");
    return init;
  });
  const set = (k: string, v: any) => setValues((s) => ({ ...s, [k]: v }));
  const accept = () => {
    const content: Record<string, unknown> = {};
    for (const [k, p] of Object.entries(props)) {
      const v = values[k];
      if (v === "" && !required.includes(k)) continue;
      content[k] = p.type === "number" || p.type === "integer" ? Number(v) : v;
    }
    resolveElicitation(item.id, "accept", content);
  };
  return (
    <div className="approve">
      <div className="at"><b>{item.name}</b>{item.message ? <span className="aa">{item.message}</span> : null}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, margin: "8px 0" }}>
        {Object.entries(props).map(([k, p]) => {
          const label = p.title || k;
          const enumVals: any[] | undefined = p.enum;
          return (
            <label key={k} style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: "0.8rem" }}>
              <span style={{ color: "var(--ink-mid,#aaa)" }}>{label}{required.includes(k) ? " *" : ""}</span>
              {p.type === "boolean" ? (
                <input type="checkbox" checked={!!values[k]} onChange={(e) => set(k, e.target.checked)} />
              ) : enumVals ? (
                <select value={values[k]} onChange={(e) => set(k, e.target.value)}>
                  {enumVals.map((v, i) => <option key={v} value={v}>{(p.enumNames?.[i]) ?? String(v)}</option>)}
                </select>
              ) : (
                <input
                  type={p.type === "number" || p.type === "integer" ? "number" : "text"}
                  value={values[k]}
                  placeholder={p.description || ""}
                  onChange={(e) => set(k, e.target.value)}
                />
              )}
            </label>
          );
        })}
        {Object.keys(props).length === 0 && item.message && <div className="note">{item.message}</div>}
      </div>
      <div className="ab">
        <button className="ay" onClick={accept}>Submit</button>
        <button className="an" onClick={() => resolveElicitation(item.id, "decline")}>Decline</button>
        <button className="an" onClick={() => resolveElicitation(item.id, "cancel")}>Cancel</button>
      </div>
    </div>
  );
}

// Human-in-the-loop: tool-approval pauses + MCP elicitation input requests, one surface.
export default function Approvals() {
  const pending = useApprovals();
  if (!pending.length) return null;
  return (
    <>
      {pending.map((p) =>
        p.kind === "elicitation" ? (
          <ElicitationForm key={p.id} item={p} />
        ) : (
          <div key={p.id} className="approve">
            <div className="at">Run <b>{p.name}</b>?<span className="aa">{(p.args || "").slice(0, 140)}</span></div>
            <div className="ab">
              <button className="ay" onClick={() => resolveApproval(p.id, true)}>Approve</button>
              <button className="an" onClick={() => resolveApproval(p.id, false, "The user rejected this tool call. Continue without it.")}>Reject</button>
            </div>
          </div>
        ),
      )}
    </>
  );
}
