# AGENTS.md — AUTOMO

AUTOMO is a **local-first browser AI agent**. It's a static page on GitHub Pages; the "backend" is the visitor's own machine — their local model, files, shell, and MCP tools — reached over Chrome's **Local Network Access (LNA)**. The page has no server it controls; it orchestrates *your* local compute.

**AUTOMO is a real `@openai/agents` SandboxAgent, running in the browser.** Not a reimplementation — the actual SDK. Inference goes to a local model over LNA (Ollama/vLLM/HF) **or a fully in-browser WebGPU engine**; the SDK's sandbox (shell, filesystem/apply_patch, skills, memory, compaction) runs **either** on the machine via the bridge **or** entirely in-page (Pyodide + just-bash + isomorphic-git) — **bridge-optional**. There's a local voice mode and it's an installable PWA. The chat surface is the **Vercel AI SDK UI** (`useChat`), driven by a custom transport that runs the agent locally.

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
│       └── lib/              (foldered by domain; each folder's index.ts preserves `from "./X"`)
│           ├── agent/        index (sandbox lifecycle · sessions · snapshots · boot) · build (buildAgent) · connect (providers · models · image)
│           ├── runtime/      transport (LocalAgentTransport + HITL loop) · model (provider-aware; resolveBrainModel) · browser-model (SDK Model over transformers.js OR web-llm) · context · guardrails · compact
│           ├── sandbox/      index (BrowserSandboxClient — bridge RPC) · persist · roots · inbrowser/ (InBrowserSandboxClient: pyodide · fs · git · client — bridge-less)
│           ├── mcp/          index (instances) · server (SDK MCPServer; http + bridge-stdio + inpage transports) · inpage (in-page stdio + built-in browser server) · shims/ (node:* browser shims)
│           ├── voice/        session · transport (RealtimeSession over local STT→model→TTS) · asr (Whisper) · tts (Kokoro) · audio (mic+VAD+playback) · pcm · config
│           ├── net/          index (LNA fetch · bridge probe · /hw) · handshake (HMAC)
│           ├── storage/      idb · opfs (File System Access) · sql (sql.js SQLite)
│           ├── platform/     locks · tabs · wakelock · badge · bgfetch (Background Fetch) · pwa (share/file handlers · install)
│           ├── tools/        search (web_search + read_url, in-browser rerank)
│           └── hitl/         approvals (tool approval + MCP elicitation)
├── servers/                  @automo/servers — the local access daemon
│   └── bridge.ts             WS ⇄ (sandbox host via UnixLocalSandboxClient + stdio pipe) + HTTP /hw probe; HMAC-gated
├── inference/                @automo/inference — hardware detection + provider-agnostic model access
│   └── hardware · provider · transformers · webllm · embed   detect→recommend; Ollama/vLLM/HF/in-browser(transformers.js|web-llm); embeddings rerank
├── .agents/skills/           repo-hosted skills the SandboxAgent can load (skills capability, via gitRepo)
└── .github/workflows/pages.yml   bun install + bun run build → deploy web/dist
```

## How the agent works

- **Chat**: `useChat` (`@ai-sdk/react`) with `LocalAgentTransport` (in `transport.ts`). `sendMessages` converts UIMessages → agent input (text + `input_image`), runs `run(SandboxAgent, input, { sandbox, stream: true })`, and returns `createAiSdkUiMessageStream(run)` (from `@openai/agents-extensions/ai-sdk-ui`) as the UIMessage stream. No server. `chat.tsx` owns per-session `UIMessage` persistence (IndexedDB), image-gen, clear/compact/stop/regenerate.
- **Model**: a provider layer (`@automo/inference`) over **Ollama / vLLM / HuggingFace / in-browser**. In-browser is real: `browser` = transformers.js (ONNX), `webllm` = MLC web-llm — both drive the agent through `BrowserModel` (a custom SDK `Model`). `runtime/model.ts` is provider-aware (vLLM native Responses = native apply_patch + compaction; Ollama/HF = `ChatCompletions` shim) and exposes `resolveBrainModel()` so **voice reuses the same model** (no second brain). Hardware detection (WebGPU incl. maxStorageBinding + VRAM budget · oscpu · WebGL renderer · WASM SIMD+threads · mobile · battery), idle-scheduled and refined by the bridge `/hw` probe, recommends a size on Connect.
- **Capabilities** (the SDK's): `shell()`, `filesystem()` (apply_patch V4A), `skills()` (lazy `gitRepo`), `memory()`, `compaction()`. Plus `web_search` + `read_url` (in-browser semantic rerank / focus-passage extraction via `inference/embed.ts`) and **MCP via the real SDK client** — with **three transports** (http · bridge-stdio · **in-page stdio** over `node:*` shims) and elicitation / roots / tasks. One typed `AutomoContext` threads through everything.
- **The sandbox — two backends**: `sandbox/index.ts` `BrowserSandboxClient` proxies over WS to the bridge's `UnixLocalSandboxClient` (real machine); `sandbox/inbrowser/` `InBrowserSandboxClient` implements the same SDK interface in-page (Pyodide + just-bash + isomorphic-git + the SDK's `applyDiff`), selectable in Settings. `ensureSandbox()` swaps clients; the agent is unchanged.
- **Voice**: `voice/` — a `RealtimeSession` (`@openai/agents-realtime`) over a custom in-browser transport (Whisper→shared model→Kokoro, AudioWorklet mic + VAD + barge-in), transcripts bridged into the chat thread.
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
3. **Ollama running + a model pulled** (in-browser via `/api/pull`). The **bridge is optional**: chat + web_search work without it, and the **in-browser sandbox** (Settings) gives shell/filesystem/git in-page with nothing installed. Run the bridge for the *real* machine (real files, native binaries) + exact `/hw` sizing. A fully in-browser stack (WebGPU model + Pyodide sandbox + in-page MCP + voice) needs no daemon at all.

## Conventions

- **Bun** everywhere. `web/` is React + Tailwind, compiled by the **React Compiler** and bundled by `bun build` to static `dist/`. `build.ts` also injects the SEO `<head>`, generates the service worker, and copies `public/`; the site URL is derived (CNAME → repo → env), never hardcoded. Verify UI with a screenshot; verify agent runs against a live bridge + Ollama (the Node-safe path in `sandbox.ts`/`transport.ts` runs under Bun for smoke tests).
- **Non-hosted by default** — the model is local; nothing touches a hosted service.
- `@openai/agents/sandbox/local` (`UnixLocalSandboxClient`) is **Node-only** — import it ONLY in `servers/bridge.ts`, never in the browser bundle. The browser bundles `@openai/agents` (+ `-core`, `-realtime`, `-extensions/ai-sdk-ui`), the raw `@modelcontextprotocol/sdk` client (the SDK's browser MCP classes are stubs that throw), `@automo/inference`, `ai`, `@ai-sdk/react`; and — when installed — the heavy in-browser deps (`@huggingface/transformers`, `@mlc-ai/web-llm`, `kokoro-js`, `sql.js`, `isomorphic-git`, `just-bash`; Pyodide from CDN). `build.ts` **conditionally externalizes** whichever of those aren't installed (dep-gated call sites throw a friendly message until added) and **aliases `node:*` → the `mcp/shims/`** so a bundled Node MCP server runs in-page. Three-workspace Bun repo: `web/` · `servers/` · `inference/`. **No file over ~235 LOC.**

## Deploy

Push to `main` with changes under `web/**` → `pages.yml` runs `bun install && bun run build` and deploys `web/dist`. Live: https://damionrashford.github.io/lna/
