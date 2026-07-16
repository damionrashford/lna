# AUTOMO browser-runtime build-out — plan & status

Thesis: make AUTOMO a **fully-capable, installable, bridge-optional** browser agent by lifting the
proven in-browser runtime patterns from four sibling repos (`gh-pages-react`, `mcp-browser`, `mlx-agent`,
`PWA-LAB`) into AUTOMO's existing abstractions.

**Branch:** `feat/automo-buildout`. **Verify:** `cd lna && bun x tsc --noEmit -p web/tsconfig.json && bun run --cwd web build`.
Heavy/optional deps are **dep-gated** (variable-specifier dynamic import) so everything bundles without
installing; each throws a clear message at runtime until its dep is added.

## Pieces

| # | Piece | Source | Where it lands |
|---|---|---|---|
| 0 | webgpu profiling merge (`maxStorageBufferBindingSize`, `budgetGB`) | gh-pages-react `webgpu.ts` | `inference/hardware.ts` |
| 1 | in-browser embeddings **rerank** + focus-passage `read_url` | mlx-agent `tools.ts` | `inference/embed.ts`, `lib/tools/search.ts` |
| 4 | **web-llm** backend for the `browser` provider | gh-pages-react `webllm.ts` | `inference/webllm.ts`, `runtime/browser-model.ts` |
| 6 | **InPageStdioTransport** (Node shims → in-page stdio MCP) | gh-pages-react `shims/` | `lib/mcp/shims/*`, `lib/mcp/server.ts` |
| S | **sql.js** store (SQLite/WASM) for memory/session index | gh-pages-react `sqljs.ts` | `lib/storage/sql.ts` |
| 2 | **Background Fetch** for model weights (survives nav/close) | PWA-LAB `capabilities.js` | `lib/platform/bgfetch.ts` |
| 5 | installable/offline **PWA shell** (manifest + SW strategies + handlers) | PWA-LAB `sw.js`, manifest | `web/public/manifest.webmanifest`, `build.ts` SW |
| 3 | **InBrowserSandboxClient** (Pyodide + just-bash + isomorphic-git) | gh-pages-react `pyodide*.ts`, `gitfs.ts` | `lib/sandbox/inbrowser/*` |

Build order: 0 → 1 → 4 → 6 → S → 2 → 5 → 3 (verifiable-first; #3 is the big bridge-less-mode feature).

## Status
- (filled in as pieces land)
