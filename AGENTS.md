# AGENTS.md — AUTOMO

AUTOMO is a **local-first browser AI agent**. The UI is a static page on GitHub Pages; the "backend" is the visitor's own machine — their local model, files, shell, and MCP tools — reached over Chrome's **Local Network Access (LNA)**. The page never sends anything to a server it controls; it orchestrates *your* local compute.

The repo is named `lna` for historical reasons (it started as an LNA reference); the product is **AUTOMO**.

## The one idea

A public HTTPS page can, with one user-granted LNA permission, open a connection to `localhost` / the LAN. AUTOMO uses that to talk to a local model (Ollama) and, optionally, a local daemon that spawns processes and stdio MCP servers. **Hosted UI, local everything else.**

## Layout (Bun workspace)

```
lna/
├── package.json          workspace root; scripts: serve · bridge · test-daemon · agent
├── web/                  @automo/web — the static site (GitHub Pages, Actions-deployed)
│   └── index.html        the AUTOMO chat app (self-contained: HTML+CSS+JS, no build)
├── servers/              @automo/servers — local daemons reached over LNA
│   ├── bridge.ts         WebSocket ⇄ child-process stdin/stdout; spawns shells + stdio MCP servers
│   └── test.ts           CORS/JSON + WS echo daemon (LNA connectivity harness)
├── agent/                @automo/agent — non-hosted OpenAI Agents JS sandbox agent
│   ├── agent.ts          full sandbox agent (shell+filesystem+skills+memory), local Ollama
│   ├── ollama.ts         transport shim (see below)
│   ├── skills.ts         skills pulled from GitHub (.agents/skills)
│   └── mounts.ts         all mount providers (local bind verified; cloud = Docker/hosted)
├── .agents/skills/       repo-hosted skills (folders: SKILL.md + scripts/), served to the agent via GitHub
└── .github/workflows/pages.yml   deploys web/ to Pages
```

## Run it

```bash
bun install                       # workspace install (root)
bun run serve                     # serve web/ locally (LNA won't fire from localhost — deploy to test it)
bun run bridge                    # BRIDGE_TOKEN=dev bun servers/bridge.ts  → 127.0.0.1:7967
bun run test-daemon               # bun servers/test.ts                     → 127.0.0.1:7966
bun run agent                     # the sandbox agent (needs Ollama running)
```

The agent needs its own deps: `cd agent && bun install` is covered by the root workspace install.

## The connection model (critical)

For the hosted page to reach local Ollama, three things must line up — the chat UI's onboarding guides all three:

1. **LNA permission** — public page → `localhost` is a loopback request; Chrome prompts, user clicks Allow. (Chrome ≥142 by default; 138–141 need `chrome://flags/#local-network-access-check` = Enabled.)
2. **CORS** — Ollama must allow the Pages origin: `OLLAMA_ORIGINS='https://damionrashford.github.io' ollama serve`. Without it the connection is allowed but the read is blocked. This is the non-obvious step.
3. **Ollama running + a model pulled.**

The chat streams from **Ollama's Responses API** (`/v1/responses`, supported since Ollama 0.13.3) — NOT Chat Completions. It passes the whole conversation as `input` each turn (Ollama's Responses is non-stateful), parses SSE events, renders `response.output_text.delta` as the answer, and shows a `thinking…` state during `response.reasoning_summary_text.delta` (reasoning models emit heavy reasoning first).

## The transport shim (`agent/ollama.ts`)

The OpenAI Agents SDK gates `apply_patch` / structured-tool / memory transports on `!modelConstructorName.includes('ChatCompletions')`. A plain Responses model claims the *native* apply_patch transport, which Ollama's `/v1/responses` doesn't implement. The shim subclasses the Responses model with a name containing `ChatCompletions`, forcing the **function-tool fallback** (Ollama-compatible) while inference stays on `/v1/responses`. Installed as the default model provider so the agent AND memory's phase models use it.

## Conventions

- **Bun**, TypeScript, ESM. No build step for `web/` — the app is one self-contained `index.html`.
- **Non-hosted by default.** Model = local Ollama; execution = `UnixLocalSandboxClient`; nothing touches a hosted service.
- **NO secrets in the repo.** The bridge's `BRIDGE_TOKEN` gates process spawning; keep it secret if you front the bridge with a public tunnel (a spawn endpoint reachable from a public origin is RCE).
- **Skills are folders** (`SKILL.md` + optional `scripts/`, `references/`, `assets/`). The agent pulls them from `github.com/damionrashford/lna` `.agents/skills` on `load_skill`.

## Deploy

Push to `main` with changes under `web/**` → the `pages.yml` Actions workflow uploads `web/` and deploys to Pages. Live: https://damionrashford.github.io/lna/

## Safety notes for agents editing this repo

- Editing `web/index.html` is the app. It's static; verify with a screenshot (`cdp-headless`) — the connection to Ollama can't be exercised from `file://` (needs a public origin + `OLLAMA_ORIGINS`).
- `servers/bridge.ts` spawns processes. Never widen its command allowlist or drop the token check without saying so explicitly.
- The Pages deploy is public. Confirm before pushing changes to `web/`.
