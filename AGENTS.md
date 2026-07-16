# AGENTS.md — AUTOMO

AUTOMO is a **local-first browser AI agent**. It's a static page on GitHub Pages; the "backend" is the visitor's own machine — their local model, files, shell, and MCP tools — reached over Chrome's **Local Network Access (LNA)**. The page has no server it controls; it orchestrates *your* local compute.

**AUTOMO is a real `@openai/agents` SandboxAgent, running in the browser.** Not a reimplementation — the actual SDK. Inference goes to the local model over LNA; the sandbox (shell, filesystem/apply_patch, skills, memory, compaction) is the SDK's, hosted on the machine by the bridge and reached over LNA. The chat surface is the **Vercel AI SDK UI** (`useChat`), driven by a custom transport that runs the agent locally.

The repo is named `lna` for historical reasons (it started as an LNA reference).

## The one idea

A public HTTPS page can, with one user-granted LNA permission, open a connection to `localhost` / the LAN. AUTOMO uses that to (a) talk to a local model (Ollama, Responses API) and (b) drive a real Unix sandbox on the machine through a small local daemon. **Hosted UI, local everything else.**

## Layout (Bun workspace)

```
lna/
├── package.json              workspace root; scripts: bridge
├── web/                      @automo/web — THE agent (React + Tailwind, bundled by Bun → static Pages site)
│   ├── index.html            entry (root div + main.tsx); SEO <head> + service worker injected at build
│   ├── build.ts              Bun.build → dist/ (React Compiler + Tailwind), inject SEO, gen sw.js, copy public/
│   ├── react-compiler-plugin.ts   runs babel-plugin-react-compiler over .tsx
│   ├── bunfig.toml           dev-server Tailwind plugin
│   ├── public/               favicon/icons, og-image, robots.txt, sitemap.xml, manifest.webmanifest (URL-tokenized)
│   └── src/
│       ├── main.tsx · App.tsx · store.ts (external store) · styles.css
│       ├── chat.tsx          ChatProvider/useAutomoChat — useChat + session persistence + multimodal + image-gen
│       ├── components/       Header · ConnectGate · Thread · Composer · Settings · Approvals · DebugPanel
│       └── lib/
│           ├── agent/        index (sandbox lifecycle · sessions · snapshots · boot) · build (buildAgent + instructions) · connect (providers · models · image)
│           ├── transport.ts  LocalAgentTransport — runs the agent, createAiSdkUiMessageStream, HITL loop, token usage
│           ├── model.ts      provider-aware model shim (vLLM native Responses vs ChatCompletions fallback), OpenAI client over LNA
│           ├── context.ts    AutomoContext (session · settings · env · log) + buildContext
│           ├── sandbox.ts    BrowserSandboxClient/Session/Editor — RPC proxy to the bridge (HMAC · AbortSignal · pre-stop hooks)
│           ├── mcp.ts · mcp-server.ts   real @modelcontextprotocol/sdk client → SDK MCPServer (elicitation · roots · tasks)
│           ├── persist.ts · roots.ts    OPFS workspace cache + folder mirror/import; MCP roots
│           ├── search.ts · guardrails.ts · approvals.ts · compact.ts
│           ├── net.ts · handshake.ts    LNA fetch + bridge probe; HMAC handshake
│           ├── idb.ts · opfs.ts         IndexedDB + OPFS / File System Access
│           └── locks.ts · tabs.ts · wakelock.ts · badge.ts   Web Locks · BroadcastChannel · Wake Lock · Badging
├── servers/                  @automo/servers — the local access daemon
│   └── bridge.ts             WS ⇄ (sandbox host via UnixLocalSandboxClient + stdio pipe); HMAC-gated
├── inference/                @automo/inference — hardware detection + provider-agnostic model access
│   └── hardware.ts · provider.ts · transformers.ts   detect → recommend; Ollama / vLLM / HuggingFace / in-browser
├── .agents/skills/           repo-hosted skills the SandboxAgent can load (skills capability, via gitRepo)
└── .github/workflows/pages.yml   bun install + bun run build → deploy web/dist
```

## How the agent works

- **Chat**: `useChat` (`@ai-sdk/react`) with `LocalAgentTransport` (in `transport.ts`). `sendMessages` converts UIMessages → agent input (text + `input_image`), runs `run(SandboxAgent, input, { sandbox, stream: true })`, and returns `createAiSdkUiMessageStream(run)` (from `@openai/agents-extensions/ai-sdk-ui`) as the UIMessage stream. No server. `chat.tsx` owns per-session `UIMessage` persistence (IndexedDB), image-gen, clear/compact/stop/regenerate.
- **Model**: a provider layer (`@automo/inference`) over **Ollama / vLLM / HuggingFace / in-browser** (transformers.js WebGPU, roadmap), streaming over LNA. `model.ts` is provider-aware — **vLLM's native Responses transport unlocks native apply_patch + server compaction**; Ollama/HF use the `ChatCompletions`-named shim so apply_patch + structured tools fall back to function tools. Browser hardware detection recommends a model size on Connect.
- **Capabilities** (all five, the SDK's): `shell()`, `filesystem()` (apply_patch V4A), `skills()` (lazy `gitRepo`), `memory()` (generation flushed via a session pre-stop hook), `compaction()` (server-side; a client-side fallback in `compact.ts` runs under the shim). Plus the `web_search` function tool and **MCP tools via the real SDK client** — with **elicitation** (schema forms), **roots** (the sandbox workspace), and **tasks** (long-running tool calls). One typed `AutomoContext` (session/settings/env/log) threads through every tool, guardrail, and the dynamic instructions.
- **The sandbox is real**: `BrowserSandboxClient` (`sandbox.ts`) proxies every `SandboxSession`/`Editor` call over WS to the bridge, which runs the SDK's **`UnixLocalSandboxClient`** — real processes, real diffs, real snapshots.
- **Human-in-the-loop** (`transport.ts` + `approvals.ts`): tools with `needsApproval` pause the run (`result.interruptions`); the transport wraps the pause→approve→resume loop in one `createUIMessageStream` (`writer.merge` per run), awaits the user's decision via the approval registry, then `state.approve/reject` and resumes from `result.state` — all within one streamed chat turn.
- **Guardrails** (`guardrails.ts`): agent `inputGuardrails`/`outputGuardrails` + tool `inputGuardrails`/`outputGuardrails` on `web_search`, gated on the `guardrails` setting. Focused on credential safety.
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
3. **Ollama running + a model pulled** (in-browser via `/api/pull`). The **bridge** must run for the sandbox (shell/filesystem/skills/memory); chat-only + web_search-via-proxy work without it.

## Conventions

- **Bun** everywhere. `web/` is React + Tailwind, compiled by the **React Compiler** and bundled by `bun build` to static `dist/`. `build.ts` also injects the SEO `<head>`, generates the service worker, and copies `public/`; the site URL is derived (CNAME → repo → env), never hardcoded. Verify UI with a screenshot; verify agent runs against a live bridge + Ollama (the Node-safe path in `sandbox.ts`/`transport.ts` runs under Bun for smoke tests).
- **Non-hosted by default** — the model is local; nothing touches a hosted service.
- `@openai/agents/sandbox/local` (`UnixLocalSandboxClient`) is **Node-only** — import it ONLY in `servers/bridge.ts`, never in the browser bundle. The browser bundles `@openai/agents` core, `@openai/agents/sandbox` (SandboxAgent, capabilities, Manifest), `@openai/agents-extensions/ai-sdk-ui`, the raw `@modelcontextprotocol/sdk` client (browser-safe Streamable HTTP + our bridge-stdio transport; the SDK's own browser MCP classes are stubs that throw), the `@automo/inference` workspace, `ai`, and `@ai-sdk/react`. Three-workspace Bun repo: `web/` · `servers/` · `inference/`. No file over ~235 LOC; `agent/` is split (index/build/connect).

## Deploy

Push to `main` with changes under `web/**` → `pages.yml` runs `bun install && bun run build` and deploys `web/dist`. Live: https://damionrashford.github.io/lna/
