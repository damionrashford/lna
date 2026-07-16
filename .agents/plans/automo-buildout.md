# AUTOMO build-out — plan & status

**Branch:** `feat/automo-buildout` (5 commits over `main`, local only, not pushed).
**State:** `bun x tsc --noEmit -p web/tsconfig.json` and `bun run --cwd web build` both GREEN.
**Pick up:** `git checkout feat/automo-buildout`.

Verify anytime:
```bash
cd lna && bun x tsc --noEmit -p web/tsconfig.json && bun run --cwd web build
```

---

## DONE (committed)

1. **Web-platform hardening + bridge HMAC + persistence** (`a4d6d6a`)
   - `lib/wakelock.ts` (Screen Wake Lock during runs), `lib/badge.ts` (Badging = pending approvals),
     `lib/locks.ts` (Web Locks — one tab drives the sandbox), `lib/tabs.ts` (BroadcastChannel session sync),
     `lib/handshake.ts` (HMAC-SHA256 nonce challenge), `lib/net.ts` (`probeBridge`).
   - `lib/sandbox.ts`: `AbortSignal.any` RPC cancel, chunked `u8ToB64` (fixes RangeError on large workspaces),
     `supportsPty` from bridge, `registerPreStopHook`/`runPreStopHooks`.
   - `servers/bridge.ts`: HMAC verify (`hmacHex` + `safeEqual`, legacy plaintext fallback), `BRIDGE_PORT` env,
     `supportsPty` in create response.
   - `lib/persist.ts`: OPFS gzip'd workspace cache (`CompressionStream`), real-folder mirror + prune
     (`removeEntry recursive`), `importFromFolder` (inline `file` manifest entries), `FileSystemObserver`
     (feature-detected, suppression-guarded), `requestDurable` (`storage.persist`). `lib/roots.ts` (MCP roots).

2. **Typed AutomoContext + guardrails-from-context + client compaction** (`e481f46`)
   - `lib/context.ts`: `AutomoContext` (session/settings/env/log) + `buildContext`. Threaded through tools,
     guardrails, dynamic instructions. Retires `session-ref.ts`.
   - `lib/guardrails.ts`: read the toggle from `context.settings.guardrails`.
   - `lib/compact.ts`: client-side compaction (structured Goal/Constraints/Progress summary) — the shim
     disables server-side. Wired into `chat.tsx` turn-settle effect.

3. **MCP over the SDK surface** (`c1acb3b`)
   - `lib/mcp-server.ts`: `SdkMcpServer` implements the SDK `MCPServer` interface, backed by the raw
     `@modelcontextprotocol/sdk` `Client`. `StreamableHTTPClientTransport` (fetch/LNA) + a custom
     `BridgeStdioTransport` (browser can't spawn → pipes over the bridge WS, HMAC handshake).
     Elicitation via `ElicitRequestSchema` handler; roots via `ListRootsRequestSchema`; tasks via
     `experimental.tasks.callToolStream`.
   - `lib/mcp.ts`: rewritten to manage instances + `activeMcpServers()` (wired into `buildAgent.mcpServers`,
     `mcpConfig.includeServerInToolNames`). **This fixed the orphaned MCP tool path** (was dead after tools.ts removal).
   - `lib/approvals.ts`: unified HITL registry (approval + elicitation); `components/Approvals.tsx` renders
     schema-driven elicitation forms. Removed dead `tools.ts`.

4. **agent.ts split** (`db708f4`) — `agent/{index,build,connect}.ts`, all <235 LOC. External `from "./agent"`
   resolves to `agent/index.ts` unchanged.

5. **Provider-agnostic inference layer + observability** (`218bf06`)
   - `@automo/inference` workspace (`lna/inference/`, registered in root + web `package.json`):
     `hardware.ts` (detectHardware via deviceMemory / hardwareConcurrency / UA-CH / WebGPU adapter /
     storage.estimate / Network / Battery → `recommendModel`), `provider.ts` (Ollama / vLLM / HuggingFace /
     browser + `pickProvider`/`providerFor`), `transformers.ts` (in-browser engine, dep-gated stub with the
     real transformers.js v3 API).
   - `lib/model.ts` (renamed from `ollama.ts`): provider-aware — **vLLM → native `OpenAIResponsesModel`
     (drops the ChatCompletions shim → native apply_patch + server compaction)**; others → shim.
   - `agent/connect.ts`: `activeProvider()`, provider-aware `refreshModels`.
   - `store.ts`: `machine`, `usage`, `logs`, `tasks` state + `S.provider`/`vllmUrl`/`hfToken`.
   - UI: `components/DebugPanel.tsx` (log ring buffer + token usage), Header token chip + debug toggle,
     ConnectGate machine recommendation, Settings backend picker.

Also verified live: HMAC handshake (auth/legacy/reject), gzip+base64 round-trip, MCP-SDK browser bundle.

---

## UNDONE — pick-up plan (by leverage)

### A. Voice port (voice-box → lna) — marquee feature
Source of truth: `../voice-box/src/transport/localTransport.ts` (the `RealtimeTransportLayer` impl) +
`../voice-box/src/config.ts`. `RealtimeSession` keeps owning history/tools/guardrails; the transport
synthesizes the event contract: `item_update(user) → turn_started → transcript_delta.. → audio.. →
item_update(assistant) → audio_done → turn_done` (tool turns insert `function_call` and defer `turn_done`).

Steps:
1. `web/package.json`: add `@openai/agents-realtime` (voice-box uses `^0.12`; match our `@openai/agents 0.13.x`).
2. `web/src/lib/voice/transport.ts` — port `LocalRealtimeTransport` ~1:1 (event synthesis is framework-agnostic).
   Swap the 3 Node deps: STT/TTS → browser (below); brain → our provider (`streamTurn` over the OpenAI client,
   reuse `activeProvider().baseURL`).
3. `web/src/lib/voice/audio.ts` — `getUserMedia` + an **AudioWorklet** that downsamples mic → 16 kHz Int16 PCM,
   energy VAD (RMS, params from voice-box config: startRms/endRms/silenceMs/minSpeechMs) → `sendAudio({commit})`.
   Playback: kokoro's 24 kHz PCM → `AudioBuffer` → `AudioContext` (queue for gapless).
4. `@automo/inference`: add `asr.ts` (whisper via transformers.js `pipeline("automatic-speech-recognition",
   "onnx-community/whisper-base.en", {device:"webgpu"})`) + `tts.ts` (kokoro-js in-browser —
   `onnx-community/Kokoro-82M-v1.0-ONNX`, dtype q8, voice `af_heart`). Both are ONNX → run in the browser.
5. `RealtimeSession` + `RealtimeAgent` wired to our tools/guardrails; feed the transport.
6. **UI/UX**: mic toggle in `components/Composer.tsx`; live waveform + listening/thinking/speaking state;
   render the running transcript as normal chat messages (shared history); **barge-in** (speaking calls
   `transport.interrupt()`, already implemented). Push-to-talk and always-on VAD share the `sendAudio` path.

Notes: kokoro-js and whisper both pull multi-MB weights (cache in OPFS/Cache API). Needs real mic/audio testing.

### B. In-browser engine actually driving the agent
`@automo/inference/transformers.ts` `createBrowserEngine` generates text but has no HTTP endpoint, so the
SandboxAgent can't point at it. Wire it into a **custom SDK `Model`** (implement the `Model` interface →
call `createBrowserEngine().chat`) so the `browser` provider drives the agent (not just chat). Add
`@huggingface/transformers` (currently a runtime-resolved dynamic import so it bundles without the dep).

### C. Finish the lib reorg (mechanical)
Only `agent/` is foldered. Apply:
```
lib/ runtime/(transport·model·context·guardrails·compact)  mcp/(index·server)  sandbox/(index·persist·roots)
     net/(index·handshake)  storage/(idb·opfs)  platform/(locks·tabs·wakelock·badge)  tools/(search)  hitl/(approvals)
```
Folder-per-old-primary preserves external `from "./X"` (→ X/index.ts). Update the moved files' relative
imports (one level deeper) + secondary-file imports. Do as its own commit; verify tsc after each group.
Hard rule: **no file > 235 LOC** (already satisfied — agent.ts was the only violator).

### D. Bridge hardware probe
Add a bridge RPC that runs `system_profiler SPDisplaysDataType` / `sysctl hw.memsize` (macOS),
`nvidia-smi --query-gpu=memory.total` (Linux/Win) → real VRAM/RAM/chip → refine `recommendModel`
(WebGPU is coarse: caps deviceMemory at 8, hides VRAM). Surface exact sizing on Connect.

### E. Computer use (dormant on Ollama)
`BridgeComputer implements Computer` (screenshot via `screencapture` → raw base64 no `data:` prefix;
click/type/keypress/move/drag via `cliclick`; scroll needs a persistent CGEvent helper or in-page JS) +
`computerTool({needsApproval})`, opt-in setting. Needs bridge computer RPCs + `brew install cliclick` +
macOS Screen-Recording & Accessibility perms. **Only fires with an OpenAI computer-use model** — Ollama
won't emit `computer_call` actions. Interface confirmed at `@openai/agents-core/dist/computer.d.ts`
(9 required methods; SDK ships interface + dispatch only, no implementation).

### F. Smaller follow-ups
- Ed25519 bridge auth (non-extractable key + one-time public-key pairing) — real upgrade **if** you tunnel
  the bridge; WebAuthn does NOT fit (it authenticates a human to a remote RP, not a local daemon).
- HF-remote fetch: `lnaFetch` adds the loopback hint always; branch to plain fetch for public HF URLs.
- Elicitation form edge cases (arrays/nested schema); currently handles string/number/boolean/enum.

### G. Browser smoke tests (cannot do headlessly)
Real browser + bridge required: OPFS persist/hydrate across reload; folder mirror/import + observer;
wake lock + badge; web locks across two tabs; broadcast-channel session sync; MCP round-trip
(tool call + elicitation + roots + tasks); provider switch to vLLM (native apply_patch/compaction path);
memory flush writing `memories/MEMORY.md`; compaction firing on a long chat; hardware recommendation.

---

## Key grounded facts (so we don't re-derive)
- **Ollama has `/v1/responses`** (v0.13.3+) but NOT the SDK's native structured-tool transport → the
  ChatCompletions-name shim is still needed for `apply_patch` on Ollama; **vLLM's native Responses drops it**.
- SDK capability session-method needs (proxy `lib/sandbox.ts` must serve): `execCommand` (hard, shell),
  `createEditor`+CRUD (hard, filesystem), `viewImage` (soft), `supportsPty`+`writeStdin` (interactive),
  `pathExists`+`materializeEntry` (skills lazyFrom + memory generate), `listDir`+`readFile` (skills from /
  memory read), `applyManifest` (else per-entry materialize), `registerPreStopHook`+flush (memory generation).
- SDK browser MCP classes are **stubs that throw** (`mcp-server/browser.js`) — hence our own client.
- transformers.js: `device:"webgpu"`, `dtype` (q4/q4f16/q8/fp16), `TextStreamer` streaming.
</content>
