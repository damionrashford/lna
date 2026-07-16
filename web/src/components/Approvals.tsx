import { useState } from "react";
import { useApprovals, resolveApproval, resolveElicitation, type PendingItem } from "../lib/approvals";

/* eslint-disable @typescript-eslint/no-explicit-any */

// Renders a JSON-Schema (primitive) elicitation request as a real form → accept(content)/decline/cancel.
function ElicitationForm({ item }: { item: PendingItem }) {
  const props: Record<string, any> = item.schema?.properties ?? {};
  const required: string[] = item.schema?.required ?? [];
  const [values, setValues] = useState<Record<string, any>>(() => {
    const init: Record<string, any> = {};
    for (const [k, p] of Object.entries(props)) {
      if (p.type === "boolean") init[k] = p.default ?? false;
      else if (p.type === "array") init[k] = Array.isArray(p.default) ? p.default.join("\n") : (p.default ?? "");
      else if (p.type === "object") init[k] = p.default ? JSON.stringify(p.default, null, 2) : "";
      else init[k] = p.default ?? "";
    }
    return init;
  });
  const set = (k: string, v: any) => setValues((s) => ({ ...s, [k]: v }));
  // Coerce a form value to its schema type. MCP elicitation is spec-limited to primitives, but a
  // non-conforming server may send array/object — parse those from a list / JSON textarea rather than
  // shipping the raw string (or rendering nothing).
  const coerce = (p: any, v: any) => {
    if (v === "" || v == null) return v;
    if (p.type === "number" || p.type === "integer") return Number(v);
    if (p.type === "array") {
      if (Array.isArray(v)) return v;
      const items = String(v).split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
      return p.items?.type === "number" || p.items?.type === "integer" ? items.map(Number) : items;
    }
    if (p.type === "object") { try { return JSON.parse(v); } catch { return v; } }
    return v;
  };
  const accept = () => {
    const content: Record<string, unknown> = {};
    for (const [k, p] of Object.entries(props)) {
      const v = values[k];
      if (v === "" && !required.includes(k)) continue;
      content[k] = coerce(p, v);
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
              ) : p.type === "array" ? (
                <textarea rows={2} value={values[k]} placeholder={p.description || "one per line, or comma-separated"} onChange={(e) => set(k, e.target.value)} />
              ) : p.type === "object" ? (
                <textarea rows={3} value={values[k]} placeholder={p.description || "JSON object"} onChange={(e) => set(k, e.target.value)} />
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
