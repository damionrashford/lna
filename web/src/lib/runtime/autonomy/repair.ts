// Tolerant JSON parsing for model output. Local/small models routinely wrap JSON in prose or ```fences,
// emit trailing commas, single quotes, or unquoted keys, or truncate mid-object. A strict JSON.parse
// throws on all of those and wastes a turn (or, in a stricter host, crashes the run). This runs an
// escalating series of repairs and, if every pass fails, degrades to a safe fallback instead of throwing.
// Used by the critic gate to read a verdict, and available to any code that must parse model-authored JSON.

// Strip a ```json … ``` (or bare ```) fence and any leading/trailing prose around the first JSON value.
function unfence(s: string): string {
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fence ? fence[1] : s).trim();
}

// Extract the first balanced {...} or [...] span, ignoring braces inside strings.
function firstBalanced(s: string): string | null {
  const start = s.search(/[{[]/);
  if (start < 0) return null;
  const open = s[start], close = open === "{" ? "}" : "]";
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return s.slice(start, i + 1);
  }
  return depth > 0 ? s.slice(start) + close.repeat(depth) : null; // truncated → close it
}

function looseFixes(s: string): string {
  return s
    .replace(/,\s*([}\]])/g, "$1")                       // trailing commas
    .replace(/([{,]\s*)'([^']+?)'\s*:/g, '$1"$2":')      // 'key': → "key":
    .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":') // bareKey: → "key":
    .replace(/:\s*'([^']*)'/g, ': "$1"');                // : 'val' → : "val"
}

// Parse model output into JSON, escalating repairs; returns undefined if nothing parses.
export function repairJson(raw: string): unknown {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const passes: ((s: string) => string)[] = [
    (s) => s,                                   // 1. as-is
    unfence,                                    // 2. strip code fence / prose
    (s) => firstBalanced(unfence(s)) ?? s,      // 3. first balanced value (also closes truncation)
    (s) => looseFixes(firstBalanced(unfence(s)) ?? unfence(s)), // 4. + loose syntax fixes
    (s) => looseFixes(unfence(s)),              // 5. loose fixes over the whole thing
  ];
  for (const pass of passes) {
    try { const v = JSON.parse(pass(raw)); if (v !== undefined) return v; } catch { /* next pass */ }
  }
  return undefined;
}

// Parse tool-call arguments; always returns an object (degrades to {}), so a caller never crashes on a
// malformed-arg emission — it gets an empty arg set and can surface a validation error instead.
export function repairToolArgs(raw: string): Record<string, unknown> {
  const v = repairJson(raw);
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
