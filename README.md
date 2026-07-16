# AUTOMO — a local-first browser AI agent

**Live:** https://damionrashford.github.io/lna/

AUTOMO is a static web page that *is* an AI agent. It runs in your browser but thinks on **your** machine: a public HTTPS page, with one user-granted **[Local Network Access](https://wicg.github.io/local-network-access/)** (LNA) permission, reaches `localhost` to drive your own model, files, shell, and MCP tools. Hosted UI, local everything else — nothing leaves your machine.

It's a real **[`@openai/agents`](https://openai.github.io/openai-agents-js/) SandboxAgent**, running in the browser — not a reimplementation. Inference goes to a local model — Ollama, vLLM, HuggingFace, or a fully **in-browser WebGPU engine** (transformers.js or MLC web-llm) — over LNA, chosen by a hardware-aware provider layer. The sandbox (shell, filesystem/`apply_patch`, skills, memory, compaction) is the SDK's, and runs **either** on your machine via a small daemon **or** entirely in the page (Pyodide + just-bash + isomorphic-git) — a **bridge-optional** design. There's a **local voice mode** (in-browser Whisper→model→Kokoro over a RealtimeSession), and AUTOMO is an **installable, offline PWA**. The chat surface is the **[Vercel AI SDK UI](https://ai-sdk.dev/docs/ai-sdk-ui)** (`useChat`), driven serverlessly by a transport that runs the agent locally.

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
- **Model** — a provider-agnostic inference layer (`@automo/inference`): **Ollama, vLLM, HuggingFace, or a fully in-browser WebGPU engine** — `transformers.js` (ONNX) or **MLC web-llm**, both driving the agent through a custom SDK `Model` (`BrowserModel`). Hardware detection (WebGPU adapter incl. `maxStorageBufferBindingSize` + a VRAM budget, `deviceMemory` / UA-CH / `oscpu` fallback / WebGL renderer / WASM SIMD+threads / mobile / storage / battery / network), scheduled at idle and **refined to exact RAM/VRAM/chip by a bridge `/hw` probe**, recommends a model size on Connect. Provider-aware model class — **vLLM's native Responses transport unlocks native `apply_patch` + server compaction**; Ollama / HuggingFace use a `ChatCompletions`-named shim (function-tool fallback).
- **Sandbox — two interchangeable backends** behind the SDK's `SandboxClient`/`SandboxSession`/`Editor`: **(1) bridge** — `BrowserSandboxClient` proxies every session call over a WebSocket to the SDK's `UnixLocalSandboxClient` (real processes, diffs, snapshots on your machine); **(2) in-browser** — `InBrowserSandboxClient` runs it all in the page: `exec` via just-bash, filesystem CRUD via the Emscripten FS + the SDK's own `applyDiff` (V4A), `materializeEntry(gitRepo)` via isomorphic-git, persist/hydrate via OPFS. Selectable in Settings; the agent runs unchanged. In-browser is zero-install and sandboxed (can't touch real host files or run native binaries).
- **Voice** — a local voice mode: a `RealtimeSession` (`@openai/agents-realtime`) over a **custom in-browser transport** that runs Whisper (STT) → the *same* provider-aware model → Kokoro (TTS), all ONNX/WebGPU, with an AudioWorklet mic + energy VAD, barge-in, and transcripts bridged into the chat thread.
- **Capabilities & tools** — the SDK's `shell`, `filesystem` (apply_patch V4A), `skills` (lazy from a GitHub repo), `memory`, `compaction`; a `web_search` tool (DuckDuckGo via CORS proxy / sandbox `curl`) with **in-browser semantic rerank + dedup**, a `read_url` tool that keeps only the passages relevant to a focus (both via in-browser embeddings); and **MCP via the real `@modelcontextprotocol/sdk` client** with **three transports** — Streamable HTTP, bridge-proxied stdio, and a **pure in-page stdio** transport (a bundled Node MCP server runs in the page over a full set of `node:*` browser shims, no bridge). Elicitation (schema forms), roots (sandbox workspace), and tasks (`callToolStream`) all supported; server-prefixed tool names.
- **Human-in-the-loop** — tools with `needsApproval` pause the run; the transport wraps the whole pause→approve→resume loop in one UIMessage stream (`createUIMessageStream` + `writer.merge`), so a single chat turn keeps streaming across the approval. MCP elicitation shares the same surface. Gated by the *"Require approval"* setting.
- **Guardrails** — SDK agent input/output guardrails + tool input/output guardrails, focused on credential safety (block pasted/leaked secrets, refuse to send secrets to web search, redact secrets from tool output). Read from the run context. Gated by the *"Credential guardrails"* setting.
- **Context** — one typed `AutomoContext` (live sandbox session, settings snapshot, run env, logger) threaded through every tool, guardrail, and the dynamic instructions (the agent's `instructions` is a function of context).
- **Persistence** — the real sandbox workspace is gzip-cached per session in OPFS (survives reloads via `persistWorkspace`/`hydrateWorkspace`) and optionally **mirrored to a granted folder** on real disk (File System Access + `FileSystemObserver`); client-side **compaction** summarizes long chats when the shim disables the server-side one.
- **Multi-tab & platform** — Web Locks (one tab owns the sandbox), BroadcastChannel (session-list sync), Screen Wake Lock (held during runs), Badging (pending-approval count on the installed PWA).
- **Observability** — per-turn token usage (from `RunContext.usage`) and a debug log panel.
- **Multimodal** — attach an image → vision turn (`input_image`, vision model); `✦` image-generation mode → `/v1/images/generations`.
- **Storage** — sessions as AI SDK `UIMessage`s in IndexedDB; an optional **sql.js (SQLite/WASM)** store for structured data (kv + query, IDB-persisted).
- **PWA** — an **installable, offline** app: the service worker precaches the shell (same-origin GET only, so LNA/model/bridge/proxy traffic is never intercepted) and, via **Background Fetch**, pre-downloads multi-MB model weights surviving navigation/close and serves them to the in-browser ML libs. The manifest ships `share_target`, `file_handlers`, `protocol_handlers` (`web+automo://`), `launch_handler`, and shortcuts — share or open a file *with* AUTOMO and it lands in the composer.

## The bridge (`servers/bridge.ts`)

The only local process. One WebSocket on `127.0.0.1:7967` carries two channels: the **sandbox RPC** (hosts `UnixLocalSandboxClient`) and a **stdio pipe** (for stdio MCP servers).

```bash
bun run bridge   # BRIDGE_TOKEN=dev bun servers/bridge.ts → 127.0.0.1:7967
```

The bridge is now **optional**: chat works without it, and the **in-browser sandbox** (Settings → Sandbox backend) gives shell/filesystem/git entirely in the page with nothing installed. Use the bridge when you want the *real* machine — full power, real files, native binaries. It also exposes `/hw` (a read-only hardware probe that refines the model recommendation) and, for the pure-in-page MCP path, is not needed at all. It spawns processes and runs a real shell, so a public page reaching it is remote code execution — gates: an **HMAC-SHA256 nonce challenge** before any op (the shared token is never sent in plaintext; a plaintext fallback keeps older clients working), a spawn allowlist, and it's bound to `127.0.0.1` (`BRIDGE_PORT` overridable). The sandbox `exec` is deliberately not allowlisted (it *is* the agent's shell), so **the token is the whole perimeter** — keep it secret if you ever front it with a tunnel.

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

`web/` is React + Tailwind, compiled by the **React Compiler** (a Babel pass wired into `build.ts`) and bundled by `bun build` to static assets. `build.ts` also injects the SEO `<head>` + service worker (with Background-Fetch handlers), copies `public/`, aliases `node:*` → the in-page MCP shims, and **conditionally externalizes** the heavy in-browser deps that aren't installed (so the bundle stays green either way; installing one makes Bun bundle it). Node-only `@openai/agents/sandbox/local` is imported **only** in the bridge; the browser bundles `@openai/agents` (+ `-core`, `-realtime`, `-extensions/ai-sdk-ui`), the raw `@modelcontextprotocol/sdk` client, `@automo/inference` (hardware / providers / embeddings / web-llm), `ai`, `@ai-sdk/react`, and — when installed — `@huggingface/transformers`, `@mlc-ai/web-llm`, `kokoro-js`, `sql.js`, `isomorphic-git`, `just-bash` (Pyodide loads from CDN). The repo is a Bun workspace: `web/` (the agent), `servers/` (the bridge), `inference/` (`@automo/inference`).

## Deploy

Push to `main` under `web/**` → `.github/workflows/pages.yml` runs `bun install && bun run build` and publishes `web/dist` to Pages. The site URL is **derived, not hardcoded** — from `public/CNAME` (custom domain), else the repo (`GITHUB_REPOSITORY` / git remote → `<owner>.github.io/<repo>/`), with `SITE_ORIGIN`/`PUBLIC_PATH` env overrides — so canonical/OG/sitemap/robots/manifest/icon paths regenerate automatically. A custom domain is just a `public/CNAME` file.

## Verified

- **Builds clean** — `tsc --noEmit` and the Bun bundler are green with **every** in-browser dep installed and bundled: transformers.js, MLC web-llm, kokoro-js, sql.js, isomorphic-git, just-bash, and the full `node:*` shim set (just-bash's `node:zlib` resolves to the shim; zero `node:` leaks in the output).
- **Bridge HMAC handshake** — tested live: the HMAC challenge authenticates, the legacy plaintext token still works, a wrong secret is rejected.
- **Bridge `/hw` probe** — tested live on macOS: returns exact chip / RAM / cores, refining the model recommendation.
- **Workspace persistence primitives** — gzip + chunked-base64 round-trip is byte-identical on 250 KB.
- **Earlier E2E** — an in-browser SandboxAgent streamed `reasoning → exec_command → apply_patch → message` against a local bridge + Ollama; a `needsApproval` tool paused/resumed; an input guardrail tripped on a pasted credential.

Runtime behavior of the newer in-browser surface — WebGPU inference (transformers.js / web-llm), voice (Whisper/Kokoro), the in-browser Pyodide sandbox (exec/git/persist), in-page MCP round-trips, semantic rerank, Background Fetch, and PWA install/share/file-open — bundles and type-checks but needs a real browser (WebGPU/OPFS/SW) to smoke-test.

## Sources

- [WICG Local Network Access spec](https://wicg.github.io/local-network-access/)
- [Chrome: New permission prompt for Local Network Access](https://developer.chrome.com/blog/local-network-access)
- [MDN: Local network access](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Local_network_access) · [OpenAI Agents JS](https://openai.github.io/openai-agents-js/) · [Vercel AI SDK UI](https://ai-sdk.dev/docs/ai-sdk-ui)

Unofficial, not affiliated with Google, Mozilla, OpenAI, or Vercel.
