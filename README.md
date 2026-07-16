# AUTOMO — a local-first browser AI agent

**Live:** https://damionrashford.github.io/lna/

AUTOMO is a static web page that *is* an AI agent. It runs in your browser but thinks on **your** machine: a public HTTPS page, with one user-granted **[Local Network Access](https://wicg.github.io/local-network-access/)** (LNA) permission, reaches `localhost` to drive your own model, files, shell, and MCP tools. Hosted UI, local everything else — nothing leaves your machine.

It's a real **[`@openai/agents`](https://openai.github.io/openai-agents-js/) SandboxAgent**, running in the browser — not a reimplementation. Inference goes to a local model — Ollama, vLLM, or (roadmap) an in-browser WebGPU engine — over LNA, chosen by a hardware-aware provider layer; the sandbox (shell, filesystem/`apply_patch`, skills, memory, compaction) is the SDK's, hosted on your machine by a small daemon and reached over LNA. The chat surface is the **[Vercel AI SDK UI](https://ai-sdk.dev/docs/ai-sdk-ui)** (`useChat`), driven serverlessly by a transport that runs the agent locally.

> The repo is named `lna` for historical reasons — it started as a Local Network Access reference.

## How it fits together

```
Browser (GitHub Pages, static)                    Your machine
┌────────────────────────────────┐                ┌──────────────────────────────┐
│ AUTOMO — React + Tailwind + RC  │                │ Ollama  /v1/responses         │
│  useChat (AI SDK UI)            │                │  (model, streaming)           │
│   └ LocalAgentTransport         │──── LNA ──────▶│                               │
│      run(SandboxAgent,{stream}) │                │                              │
│      → createAiSdkUiMessageStream│                │ bridge (servers/bridge.ts)    │
│  BrowserSandboxClient ──────────┼──── LNA (WS) ─▶│  hosts UnixLocalSandboxClient │
│   proxies every session call    │                │  → real shell, apply_patch,   │
└────────────────────────────────┘                │    materialize, snapshots     │
                                                   └──────────────────────────────┘
```

- **Chat UI** — Vercel AI SDK UI `useChat` with a custom **`LocalAgentTransport`** (no server): `sendMessages` runs the in-browser SandboxAgent and translates its streamed run into a UIMessage stream via `@openai/agents-extensions/ai-sdk-ui`'s `createAiSdkUiMessageStream`. Messages render `parts` (text, reasoning, tool calls, images). Sessions persist as AI SDK `UIMessage`s in IndexedDB.
- **Model** — a provider-agnostic inference layer (`@automo/inference`): **Ollama, vLLM, HuggingFace, or an in-browser WebGPU model** (transformers.js, roadmap). Browser hardware detection (WebGPU adapter + `deviceMemory` / UA Client Hints / storage / network) recommends a model size on the Connect screen. The model class is provider-aware — **vLLM's native Responses transport unlocks native `apply_patch` + server compaction**, while Ollama / HuggingFace use a `ChatCompletions`-named shim so `apply_patch` + structured tools fall back to ordinary function tools. Inference reaches the local server over LNA, streaming.
- **Sandbox** — `BrowserSandboxClient` implements the SDK's `SandboxClient`/`SandboxSession`/`Editor` as a thin WebSocket proxy. Every session call (`exec`, `apply_patch` via the editor, `readFile`, `listDir`, `materializeEntry`, `persistWorkspace`/`hydrateWorkspace`) is forwarded to the bridge, which runs the SDK's **`UnixLocalSandboxClient`** — real processes, real diffs, real snapshots.
- **Capabilities & tools** — the SDK's `shell`, `filesystem` (apply_patch V4A), `skills` (lazy from a GitHub repo), `memory` (generation flushed via a session pre-stop hook), `compaction`; a `web_search` function tool (DuckDuckGo HTML via a CORS proxy, falling back to the sandbox's `curl`); and **MCP via the real `@modelcontextprotocol/sdk` client** wrapped as SDK `MCPServer` instances — Streamable HTTP + a bridge-proxied stdio transport, with **elicitation** (schema-driven forms), **roots** (the sandbox workspace exposed to servers), and **tasks** (long-running tool calls polled via `callToolStream`). Server-prefixed tool names avoid collisions.
- **Human-in-the-loop** — tools with `needsApproval` pause the run; the transport wraps the whole pause→approve→resume loop in one UIMessage stream (`createUIMessageStream` + `writer.merge`), so a single chat turn keeps streaming across the approval. MCP elicitation shares the same surface. Gated by the *"Require approval"* setting.
- **Guardrails** — SDK agent input/output guardrails + tool input/output guardrails, focused on credential safety (block pasted/leaked secrets, refuse to send secrets to web search, redact secrets from tool output). Read from the run context. Gated by the *"Credential guardrails"* setting.
- **Context** — one typed `AutomoContext` (live sandbox session, settings snapshot, run env, logger) threaded through every tool, guardrail, and the dynamic instructions (the agent's `instructions` is a function of context).
- **Persistence** — the real sandbox workspace is gzip-cached per session in OPFS (survives reloads via `persistWorkspace`/`hydrateWorkspace`) and optionally **mirrored to a granted folder** on real disk (File System Access + `FileSystemObserver`); client-side **compaction** summarizes long chats when the shim disables the server-side one.
- **Multi-tab & platform** — Web Locks (one tab owns the sandbox), BroadcastChannel (session-list sync), Screen Wake Lock (held during runs), Badging (pending-approval count on the installed PWA).
- **Observability** — per-turn token usage (from `RunContext.usage`) and a debug log panel.
- **Multimodal** — attach an image → vision turn (`input_image`, vision model); `✦` image-generation mode → `/v1/images/generations`.
- **PWA** — a service worker precaches the app shell (installable, instant loads, offline shell); it only touches same-origin GET assets, so LNA/model/bridge/proxy traffic is never intercepted.

## The bridge (`servers/bridge.ts`)

The only local process. One WebSocket on `127.0.0.1:7967` carries two channels: the **sandbox RPC** (hosts `UnixLocalSandboxClient`) and a **stdio pipe** (for stdio MCP servers).

```bash
bun run bridge   # BRIDGE_TOKEN=dev bun servers/bridge.ts → 127.0.0.1:7967
```

Chat-only works without it; shell / filesystem / skills / memory need it. It spawns processes and runs a real shell, so a public page reaching it is remote code execution — gates: an **HMAC-SHA256 nonce challenge** before any op (the shared token is never sent in plaintext; a plaintext fallback keeps older clients working), a spawn allowlist, and it's bound to `127.0.0.1` (`BRIDGE_PORT` overridable). The sandbox `exec` is deliberately not allowlisted (it *is* the agent's shell), so **the token is the whole perimeter** — keep it secret if you ever front it with a tunnel.

## Connecting (once, on the machine)

1. **LNA prompt** — open the page, click **Connect**, grant Chrome's local-network prompt (Chrome ≥142, or `chrome://flags/#local-network-access-check` on 138–141).
2. **CORS** — let Ollama accept the origin: `OLLAMA_ORIGINS='https://damionrashford.github.io' ollama serve` (macOS app: `launchctl setenv OLLAMA_ORIGINS '…'` then restart). AUTOMO diagnoses this exactly — a no-cors probe tells "running but blocked" apart from "down".
3. **A model** — pull one; AUTOMO can trigger `/api/pull` from the browser.

## Develop

```bash
bun install                    # in web/
bun run --cwd web dev          # Bun fullstack dev server (HMR)
bun run bridge                 # the sandbox host, in another terminal
bun run --cwd web build        # React Compiler + Tailwind → static web/dist
```

`web/` is React + Tailwind, compiled by the **React Compiler** (a Babel pass wired into `build.ts`, since Bun's transpiler doesn't run Babel) and bundled by `bun build` to static assets. `build.ts` also injects the SEO `<head>` + service worker and copies `public/`. Node-only `@openai/agents/sandbox/local` is imported **only** in the bridge; the browser bundles `@openai/agents` core, `@openai/agents/sandbox`, `@openai/agents-extensions/ai-sdk-ui`, the raw `@modelcontextprotocol/sdk` client (Streamable HTTP + our bridge-stdio transport), the `@automo/inference` workspace (hardware detection + providers), `ai`, and `@ai-sdk/react`. The repo is a Bun workspace: `web/` (the agent), `servers/` (the bridge), `inference/` (`@automo/inference`).

## Deploy

Push to `main` under `web/**` → `.github/workflows/pages.yml` runs `bun install && bun run build` and publishes `web/dist` to Pages. The site URL is **derived, not hardcoded** — from `public/CNAME` (custom domain), else the repo (`GITHUB_REPOSITORY` / git remote → `<owner>.github.io/<repo>/`), with `SITE_ORIGIN`/`PUBLIC_PATH` env overrides — so canonical/OG/sitemap/robots/manifest/icon paths regenerate automatically. A custom domain is just a `public/CNAME` file.

## Verified

- **Builds clean** — `tsc --noEmit` and the Bun bundler (`web/build.ts`, incl. the `@modelcontextprotocol/sdk` client, `@automo/inference`, and the React Compiler pass) are green.
- **Bridge HMAC handshake** — tested live against the real bridge: the HMAC challenge authenticates, the legacy plaintext token still works, a wrong secret is rejected.
- **Workspace persistence primitives** — gzip + chunked-base64 round-trip is byte-identical to `Buffer.toString("base64")` on 250 KB.
- **Earlier E2E (pre-buildout)** — an in-browser SandboxAgent streamed `reasoning → exec_command → apply_patch → message` against a local bridge + Ollama, wrote a file and read it back; a `needsApproval` tool paused and resumed; an input guardrail tripped on a pasted credential.

Full round-trips of the newer surface — MCP tool calls / elicitation / roots / tasks, the vLLM native path, memory generation writing `MEMORY.md`, folder mirror/import — need a live bridge + model to smoke-test in a real browser.

## Sources

- [WICG Local Network Access spec](https://wicg.github.io/local-network-access/)
- [Chrome: New permission prompt for Local Network Access](https://developer.chrome.com/blog/local-network-access)
- [MDN: Local network access](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Local_network_access) · [OpenAI Agents JS](https://openai.github.io/openai-agents-js/) · [Vercel AI SDK UI](https://ai-sdk.dev/docs/ai-sdk-ui)

Unofficial, not affiliated with Google, Mozilla, OpenAI, or Vercel.
