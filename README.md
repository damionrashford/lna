# AUTOMO — a local-first browser AI agent

**Live:** https://damionrashford.github.io/lna/

AUTOMO is a static web page that *is* an AI agent. It runs in your browser but thinks on **your** machine: a public HTTPS page, with one user-granted **[Local Network Access](https://wicg.github.io/local-network-access/)** (LNA) permission, reaches `localhost` to drive your own model, files, shell, and MCP tools. Hosted UI, local everything else — nothing leaves your machine.

It's a real **[`@openai/agents`](https://openai.github.io/openai-agents-js/) SandboxAgent**, running in the browser — not a reimplementation. Inference hits your local model's Responses API over LNA; the sandbox (shell, filesystem/`apply_patch`, skills, memory, compaction) is the SDK's, hosted on your machine by a small daemon and reached over LNA.

> The repo is named `lna` for historical reasons — it started as a Local Network Access reference.

## How it fits together

```
Browser (GitHub Pages, static)                 Your machine
┌─────────────────────────────┐                ┌──────────────────────────────┐
│ AUTOMO  (React + Tailwind)   │                │ Ollama  /v1/responses         │
│  @openai/agents SandboxAgent │──── LNA ──────▶│  (model, streaming)           │
│  run(agent,{ sandbox,stream })│                │                              │
│                              │                │ bridge (servers/bridge.ts)    │
│  BrowserSandboxClient ───────┼──── LNA (WS) ─▶│  hosts UnixLocalSandboxClient │
│   proxies every session call │                │  → real shell, apply_patch,   │
└─────────────────────────────┘                │    materialize, snapshots     │
                                                └──────────────────────────────┘
```

- **Model** — local Ollama over the **Responses API**, streaming. A shim subclasses the SDK's `OpenAIResponsesModel` with a name containing `ChatCompletions` so `apply_patch` + structured tools register as ordinary function tools (which Ollama's Responses endpoint supports), while inference still hits `/v1/responses`.
- **Sandbox** — `BrowserSandboxClient` implements the SDK's `SandboxClient`/`SandboxSession`/`Editor` as a thin WebSocket proxy. Every session call (`exec`, `apply_patch` via the editor, `readFile`, `listDir`, `materializeEntry`, `persistWorkspace`/`hydrateWorkspace`) is forwarded to the bridge, which runs the SDK's **`UnixLocalSandboxClient`** — real processes, real diffs, real snapshots.
- **Capabilities** — the SDK's `shell`, `filesystem`, `skills` (lazy from a GitHub repo), `memory`, `compaction`.
- **Also** — vision (image understanding) + image generation as direct Responses calls, multi-conversation sessions (IndexedDB), workspace snapshots, and MCP (Streamable HTTP directly; stdio through the bridge).

## The bridge (`servers/bridge.ts`)

The only local process. One WebSocket on `127.0.0.1:7967` carries two channels: the **sandbox RPC** (hosts `UnixLocalSandboxClient`) and a **stdio pipe** (for stdio MCP servers).

```bash
bun run bridge   # BRIDGE_TOKEN=dev bun servers/bridge.ts → 127.0.0.1:7967
```

Chat-only works without it; shell / filesystem / skills / memory need it. It spawns processes and runs a real shell, so a public page reaching it is remote code execution — gates: a token handshake before any op, a spawn allowlist, and it's bound to `127.0.0.1`. The sandbox `exec` is deliberately not allowlisted (it *is* the agent's shell), so **the token is the whole perimeter** — keep it secret if you ever front it with a tunnel.

## Connecting (once, on the machine)

1. **LNA prompt** — open the page, click **Connect**, grant Chrome's local-network prompt (Chrome ≥142, or `chrome://flags/#local-network-access-check` on 138–141).
2. **CORS** — let Ollama accept the origin: `OLLAMA_ORIGINS='https://damionrashford.github.io' ollama serve` (macOS app: `launchctl setenv OLLAMA_ORIGINS '…'` then restart). AUTOMO diagnoses this exactly — a no-cors probe tells "running but blocked" apart from "down".
3. **A model** — pull one; AUTOMO can trigger `/api/pull` from the browser.

## Develop

```bash
bun install                    # in web/
bun run --cwd web dev          # Bun fullstack dev server (HMR)  → localhost:3000
bun run bridge                 # the sandbox host, in another terminal
bun run --cwd web build        # React Compiler + Tailwind → static web/dist (publicPath /lna/)
```

`web/` is React + Tailwind, compiled by the **React Compiler** (a Babel pass wired into `build.ts`, since Bun's transpiler doesn't run Babel) and bundled by `bun build` to static assets. Node-only `@openai/agents/sandbox/local` is imported **only** in the bridge; the browser bundles `@openai/agents` core + `@openai/agents/sandbox`.

## Deploy

Push to `main` under `web/**` → `.github/workflows/pages.yml` runs `bun install && bun run build` and publishes `web/dist` to Pages.

## Verified

End-to-end against a local bridge + Ollama (`gpt-oss:20b`): the in-browser SandboxAgent streamed `reasoning → exec_command → apply_patch → message`, wrote the answer to a real file in its sandbox, and read it back — `result.txt: 59`.

## Sources

- [WICG Local Network Access spec](https://wicg.github.io/local-network-access/)
- [Chrome: New permission prompt for Local Network Access](https://developer.chrome.com/blog/local-network-access)
- [MDN: Local network access](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Local_network_access) · [OpenAI Agents JS](https://openai.github.io/openai-agents-js/)

Unofficial, not affiliated with Google, Mozilla, or OpenAI.
