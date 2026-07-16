# AGENTS.md — AUTOMO

AUTOMO is a **local-first browser AI agent**. It's a static page on GitHub Pages; the "backend" is the visitor's own machine — their local model, files, shell, and MCP tools — reached over Chrome's **Local Network Access (LNA)**. The page has no server it controls; it orchestrates *your* local compute.

**AUTOMO is a real `@openai/agents` SandboxAgent, running in the browser.** Not a reimplementation — the actual SDK. Inference goes to the local model over LNA; the sandbox (shell, filesystem/apply_patch, skills, memory, compaction) is the SDK's, hosted on the machine by the bridge and reached over LNA.

The repo is named `lna` for historical reasons (it started as an LNA reference).

## The one idea

A public HTTPS page can, with one user-granted LNA permission, open a connection to `localhost` / the LAN. AUTOMO uses that to (a) talk to a local model (Ollama, Responses API) and (b) drive a real Unix sandbox on the machine through a small local daemon. **Hosted UI, local everything else.**

## Layout (Bun workspace)

```
lna/
├── package.json              workspace root; scripts: bridge
├── web/                      @automo/web — THE agent (React + Tailwind, bundled by Bun → static Pages site)
│   ├── index.html            entry (root div + main.tsx)
│   ├── build.ts              Bun.build → dist/ (React Compiler + Tailwind plugins, publicPath /lna/)
│   ├── react-compiler-plugin.ts  runs babel-plugin-react-compiler over .tsx (Bun's transpiler doesn't run Babel)
│   ├── bunfig.toml           dev-server Tailwind plugin
│   └── src/
│       ├── main.tsx · App.tsx · store.ts (external store via useSyncExternalStore) · styles.css
│       ├── components/       Header · ConnectGate · Thread · Composer · Settings
│       └── lib/
│           ├── agent.ts      builds the SandboxAgent + run() streaming; connection; sessions; multimodal
│           ├── ollama.ts     Responses transport shim (browser OpenAI client, fetch over LNA)
│           ├── sandbox.ts    BrowserSandboxClient/Session/Editor — RPC proxy to the bridge
│           ├── mcp.ts · net.ts · idb.ts · opfs.ts · tools.ts
├── servers/                  @automo/servers — the local access daemon
│   └── bridge.ts             WS ⇄ (sandbox host + stdio pipe)
├── .agents/skills/           repo-hosted skills the SandboxAgent can load (skills capability, via gitRepo)
└── .github/workflows/pages.yml   bun install + bun run build → deploy web/dist
```

## How the agent works

- **Model**: local Ollama over the **Responses API** (`/v1/responses`), streaming. The SDK's `OpenAIResponsesModel` is subclassed with a name containing `ChatCompletions` (the shim) so apply_patch + structured tools register as ordinary function tools — which Ollama's Responses endpoint supports — while inference still hits `/v1/responses`. Vision (`input_image`) and image generation (`/v1/images/generations`) are direct Responses calls.
- **Agent loop**: `run(agent, input, { sandbox: { session }, stream: true })`. Stream events (`raw_model_stream_event`, `run_item_stream_event`: `tool_called` / `tool_output` / `reasoning_item_created` / `message_output_created`) render into the store thread.
- **Capabilities** (all five, the SDK's): `shell()`, `filesystem()` (apply_patch V4A), `skills()` (lazy from a `gitRepo`), `memory()` (local phase models via the shim), `compaction()`.
- **The sandbox is real**: `BrowserSandboxClient` implements the SDK's `SandboxClient`/`SandboxSession`/`Editor` as a thin WS proxy. Every session method (`exec`, `createEditor`→create/update/deleteFile, `readFile`, `listDir`, `materializeEntry`, `persistWorkspace`/`hydrateWorkspace`…) RPCs to the bridge, which runs the SDK's **`UnixLocalSandboxClient`** — real processes, real diffs, real snapshots.
- **Sessions**: multi-conversation history in IndexedDB (loaded on open, saved after every turn). **Snapshots** persist the real sandbox workspace (`persistWorkspace` tar) + conversation.

## The bridge (`servers/bridge.ts`)

The only local process. Two channels over one WebSocket (127.0.0.1:7967, LNA-gated, token-gated):
1. **sandbox RPC** — hosts `UnixLocalSandboxClient`; proxies every session method. This is how the browser SandboxAgent gets a genuine Unix sandbox.
2. **stdio pipe** — spawns a process and pipes stdio (for stdio MCP servers).

```bash
bun run bridge        # BRIDGE_TOKEN=dev bun servers/bridge.ts → 127.0.0.1:7967
```

Token + spawn allowlist, bound to 127.0.0.1. The sandbox `exec` is intentionally not allowlisted (it *is* the agent's shell), so **the token is the whole perimeter** — a spawn/exec endpoint reachable from a public origin is RCE. Guard the token; never widen without saying so.

## The connection model (for chat)

1. **LNA permission** — public page → `localhost` prompts; user clicks Allow (Chrome ≥142, or the flag on 138–141).
2. **CORS** — Ollama must allow the origin: `OLLAMA_ORIGINS='https://damionrashford.github.io' ollama serve`. AUTOMO diagnoses this exactly (a no-cors probe distinguishes "running but blocked" from "down").
3. **Ollama running + a model pulled** (AUTOMO can pull models in-browser via `/api/pull`). The **bridge** must run for shell/filesystem/skills/memory (the sandbox); chat-only works without it.

## Conventions

- **Bun** everywhere. `web/` is React + Tailwind, compiled by the **React Compiler** and bundled by `bun build` to static `dist/`. Verify UI with a screenshot (`cdp-headless` / scrapling); verify agent runs against a live bridge + Ollama (the Node-safe path in `sandbox.ts` runs under Bun for smoke tests).
- **Non-hosted by default** — the model is local; nothing touches a hosted service.
- `@openai/agents/sandbox/local` (`UnixLocalSandboxClient`) is **Node-only** — import it ONLY in `servers/bridge.ts`, never in the browser bundle. The browser imports `@openai/agents` core + `@openai/agents/sandbox` (SandboxAgent, capabilities, Manifest), which bundle for the browser.

## Deploy

Push to `main` with changes under `web/**` → `pages.yml` runs `bun install && bun run build` and deploys `web/dist`. Live: https://damionrashford.github.io/lna/
