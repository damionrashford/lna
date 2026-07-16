// Client-side context compaction. Our Ollama shim names the model class `ChatCompletions`, which
// disables the SDK's server-side compaction (its samplingParams returns {}). So we do it here: when the
// conversation grows past a character budget, summarize the older turns into ONE structured note
// (the Goal/Constraints/Progress template both openclaw and hermes-agent use) and keep the recent turns
// verbatim. Runs on the user's local model over LNA. Best-effort — returns null to leave history as-is.
import { OpenAI } from "openai";
import { trimUrl, logEvent } from "../../store";
import { localFetch } from "../net/index";

/* eslint-disable @typescript-eslint/no-explicit-any */
const COMPACT_CHARS = 48000; // heuristic trigger (Ollama's OpenAI surface has no responses.compact)
const KEEP_RECENT = 6;       // turns kept verbatim after the summary

const textOf = (m: any) => (m.parts || []).filter((p: any) => p.type === "text" || p.type === "reasoning").map((p: any) => p.text).join(" ");
const sizeOf = (msgs: any[]) => msgs.reduce((n, m) => n + textOf(m).length, 0);

const SUMMARY_PROMPT = `Summarize the conversation so far into a compact handoff note. Preserve exact file paths, function names, commands, and error messages. Use these sections, omitting any that are empty:
## Goal
## Constraints
## Progress (Done / In progress / Blocked)
## Key decisions
## Next steps
## Critical context
Be terse. Output only the note.`;

// Returns a compacted message array (summary note + recent turns), or null if no compaction was needed/possible.
export async function maybeCompact(messages: any[], model: string): Promise<any[] | null> {
  if (messages.length <= KEEP_RECENT + 2 || sizeOf(messages) < COMPACT_CHARS) return null;
  const head = messages.slice(0, -KEEP_RECENT);
  const tail = messages.slice(-KEEP_RECENT);
  const transcript = head.map((m) => `${m.role}: ${textOf(m).slice(0, 4000)}`).join("\n\n").slice(0, 40000);
  try {
    const client = new OpenAI({ baseURL: trimUrl() + "/v1/", apiKey: "ollama", dangerouslyAllowBrowser: true, fetch: ((u: any, init: any) => localFetch(String(u), init)) as any });
    const res: any = await client.chat.completions.create({ model, messages: [{ role: "system", content: SUMMARY_PROMPT }, { role: "user", content: transcript }] } as any);
    const summary = res.choices?.[0]?.message?.content?.trim();
    if (!summary) return null;
    logEvent("info", `compacted ${head.length} older messages → summary (${summary.length} chars)`);
    const note = { id: "compact-" + Math.random().toString(36).slice(2, 8), role: "assistant", parts: [{ type: "text", text: "[Earlier conversation summarized]\n\n" + summary }] };
    return [note, ...tail];
  } catch (e: any) {
    logEvent("warn", "compaction failed: " + (e?.message || e));
    return null;
  }
}
