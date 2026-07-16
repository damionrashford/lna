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

## Status — ALL BUILT (2026-07-16), tsc + build green

- **0 webgpu merge** — `inference/hardware.ts`: `GpuInfo.maxStorageBindingMiB` + `gpuBudgetGB()`; recommendation gates on real OOM budget.
- **1 rerank** — `inference/embed.ts` (transformers.js feature-extraction, cosine rerank + dedup); `tools/search.ts` reranks `web_search` + new `read_url` focus-passage tool; both graceful-fallback.
- **4 web-llm** — `inference/webllm.ts` (MLC, `BrowserEngine`); `runtime/browser-model.ts` engineKind; `webllm` provider kind + Settings option.
- **6 in-page MCP** — `mcp/shims/*` (full set: process/fs/fs-promises/crypto/url/zlib/node-zlib/buffer-global/fetch-proxy/theme-check-stub) + `build.ts` node-alias plugin + `mcp/inpage.ts` `InPageStdioTransport` + built-in `browser` server + Settings "in-page". Verified: node: specifiers resolve to shims, zero leaks.
- **S sql.js** — `storage/sql.ts` (SQLite/WASM, kv + query, IDB-persisted). Dep-gated.
- **2 Background Fetch** — `platform/bgfetch.ts` + SW handlers in `build.ts` (backgroundfetchsuccess → `automo-weights` cache; fetch handler serves weights to ML libs, any origin).
- **5 PWA** — `manifest.webmanifest` gains display_override/launch_handler/share_target/file_handlers/protocol_handlers/shortcuts; `platform/pwa.ts` consumes shared/opened content → `store.intake` → composer; install-prompt capture.
- **3 InBrowserSandboxClient** — `sandbox/inbrowser/{pyodide,fs,git,client,index}.ts`: full SDK SandboxSession over Pyodide + just-bash + isomorphic-git; editor via SDK `applyDiff`; Settings toggle; `ensureSandbox()` swaps clients.

**Deps added (installed, direct):** `buffer`, `fflate` (needed by the in-page MCP shims). **Deps NOT installed (dep-gated / conditionally-externalized in build.ts, throw a friendly message until added):** `@huggingface/transformers`, `kokoro-js`, `@mlc-ai/web-llm`, `sql.js`, `isomorphic-git`, `just-bash`; Pyodide loads from CDN (no npm dep).

**Not runtime-verifiable headlessly** (need a real browser + WebGPU/OPFS/SW + the optional deps installed): rerank quality, web-llm/voice inference, in-page MCP round-trip, Background Fetch, PWA install/share/file-open, and the in-browser sandbox exec/git/persist. Bundling + type-safety of all paths IS verified.
