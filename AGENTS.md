# AGENTS.md — AUTOMO

AUTOMO is a **local-first browser AI agent**. It's a static page on GitHub Pages; the "backend" is the visitor's own machine — their local model, files, shell, and MCP tools — reached over Chrome's **Local Network Access (LNA)**. The page has no server it controls; it orchestrates *your* local compute.

**AUTOMO is the single agent.** The whole thing lives in one file, `web/index.html`. There is no separate agent process — the browser *is* the agent and the persistent, developer-owned sandbox.

The repo is named `lna` for historical reasons (it started as an LNA reference).

## The one idea

A public HTTPS page can, with one user-granted LNA permission, open a connection to `localhost` / the LAN. AUTOMO uses that to talk to a local model (Ollama, Responses API) and to a small local daemon that spawns processes and stdio MCP servers. **Hosted UI, local everything else.**

## Layout (Bun workspace)

```
lna/
├── package.json          workspace root; scripts: serve · bridge
├── web/                  @automo/web — THE agent (static, GitHub Pages, Actions-deployed)
│   └── index.html        the entire app: chat + tool loop + sessions + workspace + settings
├── servers/              @automo/servers — the local access daemon
│   └── bridge.ts         WebSocket ⇄ process stdin/stdout; runs bash (shell tool) + stdio MCP servers
├── .agents/skills/       repo-hosted skills (folders) the browser can clone into its workspace
└── .github/workflows/pages.yml   deploys web/ to Pages
```

## What the agent is (all in `web/index.html`)

- **Model**: local Ollama over the **Responses API** (`/v1/responses`), streaming, reasoning-aware, with vision (`input_image`) and image generation (`/v1/images/generations`).
- **Tool loop**: streaming `function_call` → execute in-browser → `function_call_output` → continue. Optional human-in-the-loop approval per call. Large outputs spill to OPFS; the model reads them back by range.
- **Tools**: `mem_*` (OPFS private memory, mirrored to `.automo/memory/` on a granted folder), `fs_*` + `apply_patch` (File System Access — the local-bind mount), `shell` (bash via the bridge — Unix-local exec), `http_fetch` (reach exposed localhost/LAN ports over LNA, or the web), and any **MCP** server's tools (Streamable HTTP with auth, or stdio via the bridge; filtering + prefixed names).
- **Workspace** = OPFS (virtual FS) + the granted folder + **GitHub repos cloned into OPFS** (the `gitRepo()` equivalent, concurrency-tuned).
- **Sessions**: persistent multi-conversation memory (IndexedDB) with the Session interface; **snapshots** save workspace + conversation; resume across reloads is automatic.
- **Context management**: configurable system `instructions` + live run context, a context-window budget, and client-side compaction (Ollama has no `responses.compact`).

## The bridge (`servers/bridge.ts`)

The only local process. It spawns commands and pipes stdio over a WebSocket, so AUTOMO's `shell` tool and stdio MCP servers work. Token + command allowlist, bound to `127.0.0.1`. Not needed for chat/files/memory/HTTP-MCP — only for shell and stdio MCP.

```bash
bun run bridge        # BRIDGE_TOKEN=dev bun servers/bridge.ts → 127.0.0.1:7967
```

## The connection model (for chat)

1. **LNA permission** — public page → `localhost` prompts; user clicks Allow (Chrome ≥142, or the flag on 138–141).
2. **CORS** — Ollama must allow the origin: `OLLAMA_ORIGINS='https://damionrashford.github.io' ollama serve`. AUTOMO diagnoses this exactly (a no-cors probe distinguishes "running but blocked" from "down").
3. **Ollama running + a model pulled** (AUTOMO can pull models in-browser via `/api/pull`).

## Conventions

- **Bun**, no build step. `web/index.html` is self-contained (HTML+CSS+JS) — verify UI changes with a screenshot (`cdp-headless`); the Ollama connection can't be exercised from `file://` (needs a public origin + `OLLAMA_ORIGINS`).
- **Non-hosted by default** — the model is local; nothing touches a hosted service.
- `servers/bridge.ts` spawns processes — never widen its allowlist or drop the token without saying so; a spawn endpoint reachable from a public origin is RCE.

## Deploy

Push to `main` with changes under `web/**` → `pages.yml` deploys. Live: https://damionrashford.github.io/lna/
