# AGENTS.md — AUTOMO

AUTOMO is a **local-first browser AI agent**. It's a static page on GitHub Pages; the "backend" is the visitor's own machine — their local model, files, shell, and MCP tools — reached over Chrome's **Local Network Access (LNA)**. The page has no server it controls; it orchestrates *your* local compute.

**AUTOMO is a real `@openai/agents` SandboxAgent, running in the browser.** Not a reimplementation — the actual SDK. Inference goes to a local model over LNA (Ollama/vLLM/HF) **or a fully in-browser WebGPU engine**; the SDK's sandbox (shell, filesystem/apply_patch, skills, memory, compaction) runs **either** on the machine via the bridge **or** entirely in-page (Pyodide + just-bash + isomorphic-git) — **bridge-optional**. There's an opt-in **autonomous loop**, a local voice mode, and it's an installable PWA. The chat surface is the **Vercel AI SDK UI** (`useChat`), driven by a custom transport that runs the agent locally.

The repo is named `lna` for historical reasons (it started as an LNA reference).

## The one idea

A public HTTPS page can, with one user-granted LNA permission, open a connection to `localhost` / the LAN. AUTOMO uses that to (a) talk to a local model (Ollama, Responses API) and (b) drive a real Unix sandbox on the machine through a small local daemon. **Hosted UI, local everything else.**

## Layout (Bun workspace)

```
lna/
├── package.json              workspace root; scripts: serve, bridge
├── web/                      @automo/web — THE agent (React + Tailwind, bundled by Bun → static Pages site)
│   ├── index.html            entry (root div + main.tsx); SEO <head> + service worker injected at build
│   ├── compiler.ts           Bun plugin: runs babel-plugin-react-compiler over .tsx
│   ├── playwright.config.ts  E2E config (chromium · mobile-chrome · webkit; webServer builds+serves dist)
│   ├── bunfig.toml           dev-server Tailwind plugin
│   ├── scripts/              build.ts (Bun.build → dist/: React Compiler + Tailwind, inject SEO, gen sw.js,
│   │                         copy public/, alias node:* → mcp shims, conditional-external heavy deps)
│   │                         · gen-skills-index.ts (generate the lazy-skills index from .agents/skills)
│   ├── tests/                unit/ (bun:test) · e2e/ (Playwright specs) · smoke/ (in-browser harness)
│   │                         · preview.ts (static server for dist) · visual-smoke.ts (Bun.WebView)
│   ├── public/               favicon/icons, og-image, robots.txt, sitemap.xml, manifest.webmanifest (URL-tokenized)
│   └── src/
│       ├── main.tsx · App.tsx · store.ts (external store) · styles.css
│       ├── chat.tsx          ChatProvider/useAutomoChat — useChat + session persistence + multimodal + image-gen
│       ├── components/       Header · ConnectGate · Thread · Composer · Settings · Approvals · DebugPanel · Onboarding · Plan
│       └── lib/              (foldered by domain; each folder's index.ts preserves `from "./X"`)
│           ├── agent/        index (sandbox lifecycle · sessions · snapshots · boot) · build (buildAgent + skills.generated) · connect (providers · models · image)
│           ├── runtime/
│           │   ├── model/    model (provider-aware; resolveBrainModel) · browser-model (SDK Model over transformers.js OR web-llm) · transport (LocalAgentTransport + HITL loop)
│           │   ├── context/  run-context (AutomoContext) · compact · trim · guardrails · profile (local personalization)
│           │   └── autonomy/ tasks (durable IndexedDB queue; MCP Task projection) · loop (tick reducer) · scheduler (precise timer + SW drain) · critic (output guardrail) · loopguard · cron · repair (JSON) · current (running-task id)
│           ├── sandbox/      index (BrowserSandboxClient — bridge RPC) · persist · roots · inbrowser/ (InBrowserSandboxClient: pyodide · fs · git · client — bridge-less)
│           ├── mcp/          index (instances) · server (SDK MCPServer; http + bridge-stdio + inpage transports; consumes MCP task status) · inpage (in-page stdio + built-in browser + automo-tasks servers) · shims/ (node:* browser shims)
│           ├── voice/        session · transport (RealtimeSession over local STT→model→TTS) · asr (Whisper) · tts (Kokoro) · audio (mic+VAD+playback) · pcm · config
│           ├── net/          index (LNA fetch · bridge probe · /hw) · handshake (HMAC)
│           ├── storage/      idb · opfs (File System Access) · sql (sql.js SQLite)
│           ├── platform/     locks · tabs · wakelock · badge · bgfetch (Background Fetch) · pwa (share/file handlers · install)
│           ├── tools/        search (web_search + read_url, in-browser rerank) · plan (update_plan) · schedule (schedule_task; cron) · subagent (read-only research fan-out)
│           └── hitl/         approvals (tool approval + MCP elicitation)
├── servers/                  @automo/servers — the local access daemon
│   └── bridge.ts             WS ⇄ (sandbox host via UnixLocalSandboxClient + stdio pipe) + HTTP /hw probe; HMAC-gated
├── inference/                @automo/inference — hardware detection + provider-agnostic model access
│   └── hardware · provider · transformers · webllm · embed   detect→recommend; Ollama/vLLM/HF/in-browser(transformers.js|web-llm); embeddings rerank
├── .agents/skills/           repo-hosted skills the SandboxAgent can load (skills capability, via gitRepo)
└── .github/workflows/        pages.yml (build → deploy web/dist) · e2e.yml (unit + Playwright on push/PR)
```

## How the agent works

- **Chat**: `useChat` (`@ai-sdk/react`) with `LocalAgentTransport` (`runtime/model/transport.ts`). `sendMessages` converts UIMessages → agent input (text + `input_image`), runs `run(SandboxAgent, input, { sandbox, stream: true })`, and returns `createAiSdkUiMessageStream(run)` (from `@openai/agents-extensions/ai-sdk-ui`) as the UIMessage stream. No server. `chat.tsx` owns per-session `UIMessage` persistence (IndexedDB), image-gen, clear/compact/stop/regenerate.
- **Model**: a provider layer (`@automo/inference`) over **Ollama / vLLM / HuggingFace / in-browser**. In-browser is real: `browser` = transformers.js (ONNX), `webllm` = MLC web-llm — both drive the agent through `BrowserModel` (a custom SDK `Model`). `runtime/model/model.ts` is provider-aware (vLLM native Responses = native apply_patch + compaction; Ollama/HF = `ChatCompletions` shim) and exposes `resolveBrainModel()` so **voice, critic, and compaction reuse the same model** (no second brain). Hardware detection, idle-scheduled and refined by the bridge `/hw` probe, recommends a size on Connect.
- **Tools & capabilities**: SDK capabilities `shell()`, `filesystem()` (apply_patch V4A), `skills()` (lazy `gitRepo`, index generated at build), `memory()`, `compaction()`. Function tools: `web_search` + `read_url` (in-browser semantic rerank / focus-passage extraction via `inference/embed.ts`), `update_plan`, `schedule_task`, `research`. **MCP via the real SDK client** — three transports (http · bridge-stdio · **in-page stdio** over `node:*` shims) and elicitation / roots / tasks. One typed `AutomoContext` threads through everything.
- **The sandbox — two backends**: `sandbox/index.ts` `BrowserSandboxClient` proxies over WS to the bridge's `UnixLocalSandboxClient` (real machine); `sandbox/inbrowser/` `InBrowserSandboxClient` implements the same SDK interface in-page (Pyodide + just-bash + isomorphic-git + the SDK's `applyDiff`), selectable in Settings. `ensureSandbox()` swaps clients; the agent is unchanged.
- **Autonomy** (`runtime/autonomy/`, opt-in): a durable IndexedDB **task queue** (goals, deps, retries, budgets, cron) drained by an outer **loop** — `tick(now)` is an idempotent reducer, leader-elected via Web Locks, that runs one due task per tick through the same agent/sandbox. A **scheduler** arms a precise wall-clock timer off each task's `runAfter` (+ best-effort SW wake). Per run: a **critic** output guardrail (LLM-as-judge → retry on goal-fail), a **loop-guard** (volatile-ID-stripped result fingerprint), tolerant **JSON repair**, and RunState persist/resume on approval interrupts. The queue speaks the **MCP Tasks protocol** (status vocab aligned; `toMcpTask` projection; an in-page `automo-tasks` MCP server exposes list/get/cancel; `mcp/server.ts` mirrors task-augmented MCP tool status back onto the running autonomy task).
- **Voice**: `voice/` — a `RealtimeSession` (`@openai/agents-realtime`) over a custom in-browser transport (Whisper→shared model→Kokoro, AudioWorklet mic + VAD + barge-in), transcripts bridged into the chat thread.
- **Human-in-the-loop** (`transport.ts` + `hitl/approvals.ts`): tools with `needsApproval` pause the run (`result.interruptions`); the transport wraps the pause→approve→resume loop in one `createUIMessageStream` (`writer.merge` per run), then `state.approve/reject` and resumes from `result.state` — all within one streamed chat turn.
- **Guardrails** (`context/guardrails.ts`): agent + tool guardrails on `web_search`, gated on the `guardrails` setting. Focused on credential safety.
- **Personalization** (`context/profile.ts` + `Onboarding.tsx`): one local profile per browser (name/focus/tone, `automo.profile` in localStorage), captured by a non-blocking first-run overlay and folded into the agent's instructions.
- **Observability** (`runtime/context/trace.ts`): `installObservability()` replaces the SDK's default (OpenAI-hosted) trace processor with a local one — buffers each run's span tree (agent → generation → tool → guardrail) and renders it with the console group/table API (only while the debug panel is open) plus a one-line summary in the debug log. `logEvent` carries a `%c` AUTOMO badge. Per-turn token usage from `RunContext.usage`.
- **Sessions & snapshots**: multi-conversation history (IndexedDB, UIMessages); snapshots persist the real sandbox workspace (`persistWorkspace` tar) + conversation.

## The bridge (`servers/bridge.ts`)

The only local process. Two channels over one WebSocket (127.0.0.1:7967, LNA-gated, token-gated):
1. **sandbox RPC** — hosts `UnixLocalSandboxClient`; proxies every session method. This is how the browser SandboxAgent gets a genuine Unix sandbox.
2. **stdio pipe** — spawns a process and pipes stdio (for stdio MCP servers).

```bash
bun run bridge        # BRIDGE_TOKEN=dev bun servers/bridge.ts → 127.0.0.1:7967
```

**HMAC-SHA256 nonce challenge** (the shared token is never sent in plaintext; plaintext fallback for older clients) + spawn allowlist, bound to 127.0.0.1 (`BRIDGE_PORT` overridable). The sandbox `exec` is intentionally not allowlisted (it *is* the agent's shell), so **the token is the whole perimeter** — a spawn/exec endpoint reachable from a public origin is RCE. Guard the token; never widen without saying so.

## The connection model (for chat)

1. **LNA permission** — public page → `localhost` prompts; user clicks Allow (Chrome ≥142, or the flag on 138–141).
2. **CORS** — Ollama must allow the origin: `OLLAMA_ORIGINS='https://damionrashford.github.io' ollama serve`. AUTOMO diagnoses this exactly (a no-cors probe distinguishes "running but blocked" from "down").
3. **Ollama running + a model pulled** (in-browser via `/api/pull`). The **bridge is optional**: chat + web_search work without it, and the **in-browser sandbox** (Settings) gives shell/filesystem/git in-page with nothing installed. Run the bridge for the *real* machine (real files, native binaries) + exact `/hw` sizing. A fully in-browser stack (WebGPU model + Pyodide sandbox + in-page MCP + voice) needs no daemon at all.

## Testing

- **Unit** (`bun test tests/unit`) — pure functions: JSON repair, loop-guard, cron, MCP-task projection.
- **E2E** (`bunx playwright test`, config `web/playwright.config.ts`) — chromium · mobile-chrome · webkit, against the built bundle served by `tests/preview.ts` (`PUBLIC_PATH=/`). Covers the connect gate (incl. the command-clip regression), layout/no-overflow, the onboarding flow, and the connected app (network-mocked via a `window.fetch` stub — the app's `localFetch` sets `targetAddressSpace:"loopback"`, which headless Linux Chromium routes past `page.route`).
- **Smoke** (`tests/smoke/`) — in-browser sql.js / MCP / Pyodide / embeddings. **Visual** (`tests/visual-smoke.ts`) — `Bun.WebView` screenshots.
- New tests auto-discover (bun globs `tests/unit/*.test.ts`, Playwright globs `tests/e2e/*.spec.ts`); CI (`e2e.yml`) runs both on push/PR. See `web/tests/README.md`.

## Conventions

- **Bun** everywhere. `web/` is React + Tailwind, compiled by the **React Compiler** (`compiler.ts`) and bundled by `web/scripts/build.ts` to static `dist/`. The build injects the SEO `<head>`, generates the service worker + lazy-skills index, and copies `public/`; the site URL is derived (CNAME → repo → env), never hardcoded. Verify UI with a Playwright/`Bun.WebView` screenshot; verify agent runs against a live bridge + Ollama.
- Build tooling lives under `web/scripts/` (not repo root) so it resolves `web/node_modules`.
- **Non-hosted by default** — the model is local; nothing touches a hosted service.
- `@openai/agents/sandbox/local` (`UnixLocalSandboxClient`) is **Node-only** — import it ONLY in `servers/bridge.ts`, never in the browser bundle. The browser bundles `@openai/agents` (+ `-core`, `-realtime`, `-extensions/ai-sdk-ui`), the raw `@modelcontextprotocol/sdk` client (the SDK's browser MCP classes are stubs that throw), `@automo/inference`, `ai`, `@ai-sdk/react`, `cron-schedule`; and — when installed — the heavy in-browser deps (`@huggingface/transformers`, `@mlc-ai/web-llm`, `kokoro-js`, `sql.js`, `isomorphic-git`, `just-bash`; Pyodide from CDN). `build.ts` **conditionally externalizes** whichever of those aren't installed and **aliases `node:*` → `mcp/shims/`** so a bundled Node MCP server runs in-page. Three-workspace Bun repo: `web/` · `servers/` · `inference/`. **No file over ~245 LOC.**

## Deploy

Push to `main` with changes under `web/**` → `pages.yml` runs `bun install && bun run build` and deploys `web/dist`. Live: https://damionrashford.github.io/lna/
