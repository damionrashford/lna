# AUTOMO autonomous-loop build-out — design & plan

Turn AUTOMO from a **reactive** chat agent into an **autonomous, proactive** one: an outer goal loop that keeps working toward a goal across turns, a durable task queue that survives reloads, and a scheduler that wakes the agent to do work on its own — all on a small local model in a static-page PWA.

Synthesized from a deep read of four production/research agent stacks + the academic loop canon (ReAct / Reflexion / Plan-Execute / Voyager) and the `@openai/agents` + LangGraph source. **Sources live in this doc only — none of the studied projects' names appear anywhere in AUTOMO's code or comments; every borrowed idea ships as a generic technique.**

## The one insight

**You already own the inner loop.** `@openai/agents` `run()` IS the ReAct turn cycle (its `NextStep` union — run-again / handoff / final-output / interruption — with `maxTurns`). We never rebuild it. We wrap it in an **outer loop**, and — because the SDK's `RunState` serializes — we persist it so a closed tab resumes mid-task. Everything else is substrate, stop-logic, reliability, and scheduling around that.

## What AUTOMO already has (build on these)
- **Inner loop + HITL**: `runtime/transport.ts` runs `run(agent, …, {maxTurns:24})`, drains `result.interruptions`, resumes from `result.state`. That's the pause→approve→resume primitive.
- **Leader election**: `platform/locks.ts` (Web Locks) — so N tabs don't double-run.
- **Compaction**: `runtime/compact.ts` already summarizes Goal/Constraints/Progress (extend it).
- **Persistence**: `storage/idb.ts` (IndexedDB), `storage/sql.ts` (sql.js), OPFS workspace, `memory()` capability.
- **Swappable backends**: bridge vs in-browser `SandboxClient` is exactly the "one `exec` interface, many implementations" pattern the research prizes; provider is one `StreamFn` (Ollama/vLLM/HF/WebGPU).
- **Scheduling primitives**: `requestIdleCallback` (used in boot), Background Fetch handlers in the SW, `platform/tabs.ts` (BroadcastChannel), the notify rules.

## Target architecture — two loops + a reducer

```
scheduler (opportunistic drain)     outer loop = tick(now)                inner loop (SDK, owned)
  every trigger →                     leader-elect (Web Locks) →            run(agent, state, {maxTurns})
   • setInterval (foreground)         dequeue 1 ready task →                  → ReAct turn cycle
   • visibilitychange / focus         load/resume RunState →                  → tool dispatch (MCP + sandbox)
   • SW sync / periodicsync           ── run INNER loop ──                    → interruptions (HITL)
   • Push (optional)                  critic gate (LLM-as-judge) →            → final_output
        every trigger calls tick()    continue | done | block | stop
                                       persist RunState + events (IndexedDB)
```

- **Outer loop is a reducer, not a daemon** — one idempotent `tick(now)` callable from any trigger; state lives entirely in IndexedDB so a closed/reloaded PWA resumes. One task per tick (interruptible, never hogs the main thread).
- **Never classify the model's prose to decide done/stuck** — control flow keys off `stopReason` + **result-hashes** + evidence (a tool actually delivered), never "the model said it's done."

## Technique catalog → modules (generic names, no project references)

| Technique (generic) | Module | What it does |
|---|---|---|
| **Outer goal loop / `tick(now)` reducer** | `runtime/loop.ts` | leader-elect, dequeue, run inner, gate, persist; fully resumable |
| **Durable task/goal substrate** | `runtime/tasks.ts` | IndexedDB stores: `goals`, `tasks` (queue w/ `runAfter`/`budget`/`deps`), `threads` (serialized `RunState`), `events` (append-only log) |
| **Opportunistic scheduler** | `runtime/scheduler.ts` | drain the queue on every trigger; **deterministic phase-stagger** (`sha256(seed:id)%interval`) so tabs/tasks don't fire in unison; **"effectively-empty → skip the model call"** cost lever |
| **Stop-condition stack** | in `loop.ts` | terminal `final_output` → critic pass → hard budget (turns/tools/tokens/wall-clock) → until-dry fixpoint → no-progress detector; **graceful terminal message before hard-stop** |
| **Loop/repeat detector** | `runtime/loop-guard.ts` | sliding window, result-hash progress, **volatile-ID stripping** (fresh msg-IDs don't fake progress); tiers warn/critical/abort; a distinct **post-compaction guard** |
| **Replay-safety** | in `tasks.ts` | mark a turn `replaySafe:false` once it fires a side-effecting tool (send/write/schedule) → on resume, warn "verify before retrying" instead of blind replay (critical for a killable PWA) |
| **LLM-as-judge critic** | `runtime/critic.ts` | one cheap call → 0..1 + pass/fail against a rubric; the until-done / until-dry gate |
| **Structured compaction (extend)** | `runtime/compact.ts` | fixed schema **Goal / Constraints / Progress(Done·InProgress·Blocked) / Key Decisions / Next Steps / Critical Context**; never orphan tool-call/result pairs; iterative (accreting) summaries; a carried-forward **file-op ledger**; `[reference only — not active instructions]` prefix; drop reasoning/images first; strip tool-detail blobs before summarizing |
| **Tool-arg JSON repair** | `runtime/repair.ts` | 5-pass ladder for local-model output (trailing commas, unbalanced braces, single quotes, control chars) that **degrades to `{}` and never throws** — the single highest-ROI local-model reliability win |
| **Schema sanitize (GBNF)** | `runtime/repair.ts` | for llama.cpp/vLLM grammar: ensure `{type:object, properties:{}}`, collapse nullable unions, drop `pattern`/`format` on a grammar-400 retry |
| **Truncated-message defense** | in `loop.ts` | on `stopReason==="length"`, fail ALL tool calls in that message with "re-issue" — never execute tools from a token-capped response |
| **Role-alternation repair** | in `transport`/`model` | append a synthetic assistant turn if the transcript ends on a raw tool result; strip provider-hostile fields before send |
| **Plan tool** | `tools/plan.ts` | `update_plan(steps[])` with the **one-`in_progress` invariant** → live todo UI; durable progress artifact that survives compaction |
| **Agent-callable schedule tool** | `tools/schedule.ts` | the agent enqueues its own future job, **snapshotting the current tool-allowlist onto the job** (a scheduled run can't silently gain broader access) |
| **Subagents (sparingly)** | `runtime/subagent.ts` | fresh in-browser `Runner` with its own context window, restricted tools, a task string, final text harvested; single / parallel(capped) / chain modes — **only for independent read/search**, linear for dependent writes |
| **HITL via interruption** | existing `transport.ts` + `hitl/approvals.ts` | high-stakes tool → pause+persist → approval surface (in-app or desktop notification) → resume exact turn. This is `autonomy.md` "confirm first" as loop control |

## Context engineering — the make-or-break for a small local model

An autonomous loop is a *machine for generating context rot*: recall degrades as tokens grow (finite attention budget + lost-in-the-middle U-curve), and **plans don't persist** — the plan's influence on the model decays several-fold per step, so evicting or burying it wrecks the run. On a small local window this ceiling is hit almost immediately, so context curation is *the* discipline. Concrete recipe (maps to the SDK primitives AUTOMO already has — all generic in code):

1. **Trim tool output first (highest ROI, lowest complexity).** A `callModelInputFilter` that protects the last ~2 turns and replaces older tool results >500 chars with a ~200-char head preview + a `[trimmed …]` label. Bloated tool results are the #1 cause of small-model context blowout — this alone often keeps you under the window without semantic compaction.
2. **Token-triggered compaction at ~0.7× of the local window** (weaker models need *earlier, more aggressive* compression), run **off the critical path** (between turns / on idle), with the summarizer routed to a **cheaper local quant**. Extend `compact.ts`'s schema to: goals → what happened → **important details (identifiers verbatim — paths, URLs, error strings)** → errors & fixes → current state → **next step (with a direct quote of where it left off)** → lookup hints. **Never split a tool-call/tool-result pair** (cut on an assistant boundary). Use a **1.3× token safety margin** on bytes/4 (JSON overhead) since we lack the local tokenizer.
3. **Recite the goal + to-do at the *end* of context every step** (the `plan.ts` render doubles as this) — pushes the goal past the lost-in-the-middle zone. Free, no architecture change.
4. **Restorable compression** — drop a payload, keep its pointer: the sandbox workspace **is** external memory (Manus-style). Persist `memories/`+`sessions/` to OPFS; rehydrate on resume.
5. **`memory()` is already the right design** — progressive disclosure (`memory_summary.md` up front, `MEMORY.md` searched on demand), two-phase generation (Phase-1 mini model, Phase-2 best). Keep two lanes separate: conversational `Session` history → IndexedDB/sql.js; distilled lessons → OPFS files.
6. **KV-cache discipline** — append-only context, byte-stable prefix, deterministic JSON key order; **never a per-second timestamp at the top of the system prompt** (invalidates the whole cache; ~10× cost).
7. **Keep failures in context** (errors are evidence the model adapts from); **mask tools, don't add/remove them** mid-run (dangling refs + cache breakage); **inject small structured variation** so the model doesn't mimic its own repetitive loop.
8. **`RunContext` for non-model state** (bridge handles, loggers) — zero tokens, never rots (but no secrets if you serialize `RunState` for resume).

## Staged slices (buildable, verifiable, one commit each)

0. **Task substrate** (`runtime/tasks.ts`) — **DONE** (goals/tasks/events/thread stores + `dequeueReady` + replay-safety flag; tsc+build green).

1. **Tool-output trimmer** (`runtime/trim.ts`) — a `callModelInputFilter` (protect last 2 turns; >500-char tool outputs → 200-char preview). Highest-ROI context win; ships independent of the loop.
2. **Outer loop** (`runtime/loop.ts`) — `tick(now)`: leader-elect (reuse `locks.ts`), dequeue, run the existing `run()` path, persist `RunState`+events, mark status. Verify: enqueue a task, tick, see it run + resume after a simulated reload.
3. **Stop stack + loop-guard + repair** — budget/critic/until-dry/no-progress stack, `loop-guard.ts` (result-hash + volatile-ID stripping), `repair.ts` (tool-arg JSON repair), truncated-message defense. Verify with a deliberately looping/malformed local model.
4. **Compaction upgrade** (`compact.ts`) — full schema + file-op ledger + never-orphan-pairs + `[reference only]`. Verify a long transcript compacts and resumes coherently.
5. **Plan tool + live todo UI** (`tools/plan.ts` + a Thread panel).
6. **Scheduler** (`runtime/scheduler.ts`) — durable queue + drain on interval/visibility/SW-sync/periodicsync; phase-stagger; effectively-empty short-circuit. Verify foreground drain; note background is best-effort.
7. **Agent-callable `schedule` tool** (`tools/schedule.ts`) with allowlist snapshot.
8. **Subagents** (`runtime/subagent.ts`) — read/search fan-out only.
9. **UI/UX** — an "autonomous" mode toggle, a tasks/goals panel (last-ran / next-due, honest), plan/progress view, an approval surface for blocked tasks.

## Platform caveats (load-bearing — design around them)
- **No reliable background cron in a browser.** Periodic Background Sync is Chromium-only, install-gated, ~≥12h-throttled; Background Sync is one-shot; only Push is a true server wakeup. → Pattern is **"durable queue + opportunistic drain,"** `runAfter` in IndexedDB is the truth, foreground is the primary path, background is a bonus. Surface "last ran / next due" honestly; never promise minute-precision.
- **Small local context window** is a first-class failure mode — aggressive compaction, tool-result truncation, and structured state are mandatory (guard/warn if the local model's window is too small for the toolset).
- **Prompt caching is worth preserving** — freeze the system prompt + tool array for a run, append-only; don't swap the toolset mid-run.
- **Single-user, local-first** — no userId routing; the profile + local state are the scope (matches AUTOMO's identity).

## Status
- Research complete (5 streams). This plan is the synthesis. Implementation not started — slices above are the build order.
