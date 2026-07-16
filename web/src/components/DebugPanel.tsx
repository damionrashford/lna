// Debug panel — a live view of the run log (context.log / logEvent ring buffer) and the last turn's
// token usage (RunContext.usage). Toggled from the Header. Inline-styled so it needs no extra CSS.
import { useStore, set } from "../store";

const box: React.CSSProperties = {
  position: "fixed", right: 12, bottom: 12, width: 380, maxHeight: "50vh", zIndex: 60,
  display: "flex", flexDirection: "column", background: "var(--surface-2, #1b1a22)",
  border: "1px solid var(--border, #333)", borderRadius: 10, boxShadow: "0 8px 30px rgba(0,0,0,.4)",
  fontFamily: "var(--mono, ui-monospace, monospace)", fontSize: "0.72rem", overflow: "hidden",
};

export default function DebugPanel() {
  const { debugOpen, logs, usage } = useStore();
  if (!debugOpen) return null;
  const color = (lvl: string) => (lvl === "error" ? "#f5906f" : lvl === "warn" ? "#e0b050" : "var(--ink-mid, #aaa)");
  return (
    <div style={box} role="log" aria-label="Debug">
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderBottom: "1px solid var(--border,#333)" }}>
        <strong>Debug</strong>
        {usage && <span style={{ color: "var(--ink-mid,#aaa)" }}>{usage.total.toLocaleString()} tok · {usage.requests} req · in {usage.input}/out {usage.output}</span>}
        <div style={{ flex: 1 }} />
        <button onClick={() => set({ logs: [] })} style={{ background: "none", border: "none", color: "var(--coral,#f5906f)", cursor: "pointer", font: "inherit" }}>clear</button>
        <button onClick={() => set({ debugOpen: false })} aria-label="Close" style={{ background: "none", border: "none", color: "var(--ink,#eee)", cursor: "pointer", fontSize: "1rem" }}>×</button>
      </div>
      <div style={{ overflowY: "auto", padding: "6px 10px" }}>
        {logs.length === 0 && <div style={{ color: "var(--muted,#777)" }}>no events yet — send a message</div>}
        {logs.slice().reverse().map((l, i) => (
          <div key={i} style={{ padding: "2px 0", color: color(l.level), whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            <span style={{ color: "var(--muted,#777)" }}>{new Date(l.t).toLocaleTimeString()} </span>{l.msg}
          </div>
        ))}
      </div>
    </div>
  );
}
