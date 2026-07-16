// Provider-agnostic inference layer. One interface over every backend AUTOMO can talk to, so the
// agent doesn't care whether the model runs in a local server, a remote endpoint, or the browser:
//   - ollama       — local server over LNA (OpenAI-compatible; /v1/responses exists but not the SDK's
//                    native structured-tool transport, so apply_patch stays a function tool).
//   - vllm         — local/remote OpenAI-compatible; NATIVE /v1/responses ⇒ native apply_patch + server
//                    compaction (the full SDK capability set, no ChatCompletions shim needed).
//   - huggingface  — remote OpenAI-compatible router (needs a token; NOT local — data leaves).
//   - browser      — in-browser WASM/WebGPU via transformers.js (@huggingface/transformers); zero
//                    install, fully local, but generation-only (no HTTP endpoint / native tool calling).
// The router picks the best available given the hardware profile + what's configured/reachable.
import type { HardwareProfile, ModelRecommendation } from "./hardware";
import { recommendModel } from "./hardware";

export type ProviderKind = "ollama" | "vllm" | "huggingface" | "browser";
export type FetchLike = (input: any, init?: any) => Promise<Response>;

export interface InferenceProvider {
  kind: ProviderKind;
  label: string;
  local: boolean;             // runs on the user's machine/browser — nothing leaves
  responsesNative: boolean;   // implements the SDK's native Responses transport (native apply_patch + compaction)
  httpEndpoint: boolean;      // exposes an OpenAI-compatible HTTP baseURL the agent can point at
  baseURL?: string;           // OpenAI-compatible endpoint; undefined for the in-browser engine
  probe(f?: FetchLike): Promise<boolean>;
  listModels(f?: FetchLike): Promise<string[]>;
}

export interface ProviderConfig {
  ollamaUrl?: string;         // default http://localhost:11434
  vllmUrl?: string;           // default http://localhost:8000
  hfToken?: string;           // HuggingFace router token (remote)
}

const names = (json: any): string[] =>
  (json?.models || json?.data || []).map((m: any) => m.name || m.id).filter(Boolean);

export function ollamaProvider(cfg: ProviderConfig = {}): InferenceProvider {
  const base = (cfg.ollamaUrl || "http://localhost:11434").replace(/\/$/, "");
  return {
    kind: "ollama", label: "Ollama (local)", local: true, responsesNative: false, httpEndpoint: true, baseURL: base + "/v1/",
    async probe(f = fetch) { try { return (await f(base + "/api/tags")).ok; } catch { return false; } },
    async listModels(f = fetch) { try { return names(await (await f(base + "/api/tags")).json()); } catch { return []; } },
  };
}

export function vllmProvider(cfg: ProviderConfig = {}): InferenceProvider {
  const base = (cfg.vllmUrl || "http://localhost:8000").replace(/\/$/, "");
  return {
    kind: "vllm", label: "vLLM (native Responses)", local: true, responsesNative: true, httpEndpoint: true, baseURL: base + "/v1/",
    async probe(f = fetch) { try { return (await f(base + "/v1/models")).ok; } catch { return false; } },
    async listModels(f = fetch) { try { return names(await (await f(base + "/v1/models")).json()); } catch { return []; } },
  };
}

export function huggingfaceProvider(cfg: ProviderConfig = {}): InferenceProvider {
  const base = "https://router.huggingface.co/v1";
  const auth = cfg.hfToken ? { Authorization: "Bearer " + cfg.hfToken } : undefined;
  return {
    kind: "huggingface", label: "HuggingFace (remote)", local: false, responsesNative: false, httpEndpoint: true, baseURL: base + "/",
    async probe(f = fetch) { try { return (await f(base + "/models", { headers: auth as any })).ok; } catch { return false; } },
    async listModels(f = fetch) { try { return names(await (await f(base + "/models", { headers: auth as any })).json()); } catch { return []; } },
  };
}

// In-browser engine descriptor (transformers.js / WebGPU). Generation lives in transformers.ts — it has
// no HTTP endpoint, so it drives a degraded tools-less chat unless wrapped in a custom SDK Model.
export function browserProvider(): InferenceProvider {
  return {
    kind: "browser", label: "In-browser (transformers.js / WebGPU)", local: true, responsesNative: false, httpEndpoint: false,
    async probe() { return typeof navigator !== "undefined" && !!(navigator as any).gpu; },
    async listModels() { return BROWSER_MODELS; },
  };
}

// Curated ONNX text-generation models that run in transformers.js (library=transformers.js on the Hub).
export const BROWSER_MODELS = [
  "onnx-community/Qwen2.5-0.5B-Instruct",
  "onnx-community/Llama-3.2-1B-Instruct",
  "HuggingFaceTB/SmolLM2-1.7B-Instruct",
  "onnx-community/Qwen2.5-3B-Instruct",
];

export function allProviders(cfg: ProviderConfig = {}): InferenceProvider[] {
  return [ollamaProvider(cfg), vllmProvider(cfg), huggingfaceProvider(cfg), browserProvider()];
}

// Build a provider from an explicit kind (the user's selection), applying config.
export function providerFor(kind: ProviderKind, cfg: ProviderConfig = {}): InferenceProvider {
  return kind === "vllm" ? vllmProvider(cfg)
    : kind === "huggingface" ? huggingfaceProvider(cfg)
    : kind === "browser" ? browserProvider()
    : ollamaProvider(cfg);
}

// Auto-pick the best available backend: prefer a reachable local server (vLLM first — it unlocks native
// apply_patch + compaction), then Ollama, then the in-browser engine if the hardware can run it, then
// HuggingFace (remote, only if a token is set). Returns the provider + why + the model recommendation.
export async function pickProvider(
  profile: HardwareProfile,
  cfg: ProviderConfig = {},
  f: FetchLike = fetch,
): Promise<{ provider: InferenceProvider; reason: string; recommendation: ModelRecommendation }> {
  const rec = recommendModel(profile);
  const vllm = vllmProvider(cfg), ollama = ollamaProvider(cfg);
  if (await vllm.probe(f)) return { provider: vllm, reason: "vLLM reachable — native Responses (full capability set)", recommendation: rec };
  if (await ollama.probe(f)) return { provider: ollama, reason: "Ollama reachable over LNA", recommendation: rec };
  if (rec.canRunInBrowser) return { provider: browserProvider(), reason: "no local server, but the GPU can run a model in-browser", recommendation: rec };
  if (cfg.hfToken) return { provider: huggingfaceProvider(cfg), reason: "no local option; falling back to HuggingFace (remote)", recommendation: rec };
  return { provider: ollama, reason: "nothing reachable — start Ollama, run vLLM, or grant WebGPU", recommendation: rec };
}
