// Client-side context compaction. Our Ollama shim names the model class `ChatCompletions`, which
// disables the SDK's server-side compaction (its samplingParams returns {}). So we do it here: when the
// conversation grows past a character budget, summarize the older turns into ONE structured note
// (a Goal/Constraints/Progress handoff template) and keep the recent turns verbatim. Runs on the user's
// local model over LNA. Best-effort — returns null to leave history as-is.
import { Agent, run } from "@openai/agents";
import { logEvent } from "../../../store";
import { installModelProvider } from "../model/model";

/* eslint-disable @typescript-eslint/no-explicit-any */
const CONTEXT_BUDGET = 48000;                                 // ~ the working-context ceiling in chars
const COMPACT_TRIGGER = Math.floor(CONTEXT_BUDGET * 0.7);     // compact PROACTIVELY at 70% — before a turn
                                                             // can overflow the window, not at the brink
const KEEP_RECENT = 6;                                        // turns kept verbatim after the summary

const textOf = (m: any) => (m.parts || []).filter((p: any) => p.type === "text" || p.type === "reasoning").map((p: any) => p.text).join(" ");
const sizeOf = (msgs: any[]) => msgs.reduce((n, m) => n + textOf(m).length, 0);

const SUMMARY_PROMPT = `Summarize the conversation so far into a compact handoff note for continuing the work. Preserve exact file paths, function names, commands, and error messages verbatim. This note REPLACES the earlier turns, so anything not captured here is lost — but do not reproduce file contents; reference the file path as the source of truth and let the reader re-open it. Use these sections, omitting any that are empty:
## Goal
## What happened (the concrete actions taken so far, terse, in order)
## Files touched (a ledger — one line each: \`path — created|edited|deleted — what changed\`)
## Constraints
## Progress (Done / In progress / Blocked)
## Key decisions
## Next steps (quote the immediate next action verbatim; be specific enough to act on without re-reading history)
## Critical context (anything else required to continue that isn't recoverable from the files)
Be terse. Output only the note.`;

// Returns a compacted message array (summary note + recent turns), or null if no compaction was needed/possible.
export async function maybeCompact(messages: any[], model: string): Promise<any[] | null> {
  if (messages.length <= KEEP_RECENT + 2 || sizeOf(messages) < COMPACT_TRIGGER) return null;
  const head = messages.slice(0, -KEEP_RECENT);
  const tail = messages.slice(-KEEP_RECENT);
  const transcript = head.map((m) => `${m.role}: ${textOf(m).slice(0, 4000)}`).join("\n\n").slice(0, 40000);
  try {
    installModelProvider(model); // summarize through the one brain (the user's configured provider)
    const summarizer = new Agent({ name: "compactor", model, instructions: SUMMARY_PROMPT });
    const res: any = await run(summarizer, transcript, { maxTurns: 1 } as any);
    const summary = (typeof res.finalOutput === "string" ? res.finalOutput : JSON.stringify(res.finalOutput ?? "")).trim();
    if (!summary) return null;
    logEvent("info", `compacted ${head.length} older messages → summary (${summary.length} chars)`);
    const note = { id: "compact-" + Math.random().toString(36).slice(2, 8), role: "assistant", parts: [{ type: "text", text: "[Earlier conversation summarized]\n\n" + summary }] };
    return [note, ...tail];
  } catch (e: any) {
    logEvent("warn", "compaction failed: " + (e?.message || e));
    return null;
  }
}
