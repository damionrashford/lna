// Tool-output trimmer — a model-input filter that runs before every model call. Bloated tool results
// (search dumps, file reads, long shell output) are the main cause of a small context window overflowing,
// so this protects the most recent turns verbatim and replaces older, oversized tool outputs with a short
// head preview plus a labelled note: the causal thread survives while token weight drops.
import type { CallModelInputFilter } from "@openai/agents";

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface TrimOptions {
  recentTurns?: number;  // how many trailing user turns to leave untouched
  maxChars?: number;     // trim tool outputs longer than this…
  previewChars?: number; // …down to this head preview
}

export function toolOutputTrimmer(opts: TrimOptions = {}): CallModelInputFilter {
  const recentTurns = opts.recentTurns ?? 2;
  const maxChars = opts.maxChars ?? 500;
  const preview = opts.previewChars ?? 200;

  return ({ modelData }: any) => {
    const input: any[] = modelData.input ?? [];
    // protect everything from the Nth-from-last user message onward (the live thread)
    const userIdx = input.map((it, i) => (it?.role === "user" ? i : -1)).filter((i) => i >= 0);
    const protectFrom = userIdx.length > recentTurns ? userIdx[userIdx.length - recentTurns] : 0;

    const trimmed = input.map((it, i) => {
      if (i >= protectFrom || it?.type !== "function_call_result") return it;
      const out = it.output;
      const text = typeof out === "string" ? out : out?.text ?? "";
      if (typeof text !== "string" || text.length <= maxChars) return it;
      const label = `${text.slice(0, preview)}\n[trimmed: ${it.name ?? "tool"} output — ${text.length} chars → ${preview}-char preview; re-run the tool if you need the full result]`;
      return { ...it, output: typeof out === "string" ? label : { ...out, text: label } };
    });
    return { ...modelData, input: trimmed };
  };
}
