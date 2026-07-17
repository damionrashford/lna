// Observability — turn the Agents SDK's tracing into something useful locally. The SDK emits a structured
// span tree for every run (agent → generation → tool/function → guardrail); by default it tries to export
// those to OpenAI's hosted backend (a key we don't have), so they're otherwise dark. We REPLACE the
// default processor with a local one: buffer each trace's spans, then render them with the console
// group/table API and mirror a one-line summary into the debug panel. Global — chat and autonomous runs
// alike. Rich console output only when the debug panel is open, so a normal session stays quiet.
import { setTraceProcessors } from "@openai/agents";
import { getState, logEvent } from "../../../store";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = { span: string; type: string; ms: number | ""; error?: string };
const buffers = new Map<string, { name: string; rows: Row[] }>();

// duration from the span's ISO timestamps (SDK spans expose startedAt/endedAt as ISO strings)
const durMs = (s: any): number | "" => {
  const a = s?.startedAt ? Date.parse(s.startedAt) : NaN, b = s?.endedAt ? Date.parse(s.endedAt) : NaN;
  return Number.isFinite(a) && Number.isFinite(b) ? b - a : "";
};
// a readable name per span type (agent/function/custom carry `name`; generation carries the model)
const nameOf = (d: any): string => d?.name ?? d?.model ?? d?.type ?? "span";

const BADGE = "background:oklch(76% 0.14 32);color:#181016;padding:1px 6px;border-radius:4px;font-weight:700";

let installed = false;
export function installObservability() {
  if (installed) return;
  installed = true;
  // one processor, no OpenAI exporter — spans flow here, never off-machine
  setTraceProcessors([
    {
      async onTraceStart(t: any) { buffers.set(t.traceId, { name: t.name || "run", rows: [] }); },
      async onSpanStart(_s: any) { /* buffered on end */ },
      async onSpanEnd(s: any) {
        const buf = buffers.get(s.traceId);
        if (buf) buf.rows.push({ span: nameOf(s.spanData), type: s.spanData?.type ?? "span", ms: durMs(s), error: s.error?.message });
      },
      async onTraceEnd(t: any) {
        const buf = buffers.get(t.traceId);
        buffers.delete(t.traceId);
        if (!buf) return;
        const total = buf.rows.reduce((n, r) => n + (typeof r.ms === "number" ? r.ms : 0), 0);
        const errs = buf.rows.filter((r) => r.error).length;
        logEvent(errs ? "warn" : "info", `trace "${buf.name}" — ${buf.rows.length} spans · ${total}ms${errs ? ` · ${errs} error(s)` : ""}`);
        // rich, structured console output — collapsed group + a table of spans — only while debugging
        if (getState().debugOpen && typeof console.groupCollapsed === "function") {
          console.groupCollapsed(`%cAUTOMO%c ${buf.name}  %c${total}ms`, BADGE, "", "color:#888");
          console.table(buf.rows);
          console.groupEnd();
        }
      },
      async shutdown() { /* nothing to flush */ },
      async forceFlush() { /* nothing to flush */ },
    },
  ]);
  logEvent("info", "observability: SDK tracing → console + debug panel");
}
