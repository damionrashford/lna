// Ollama transport shim for the in-browser @openai/agents runtime.
//
// The SDK gates apply_patch / structured-tool / compaction on the NATIVE Responses
// transport, which it enables when the model class name does NOT contain "ChatCompletions".
// Ollama's /v1/responses doesn't implement that native transport, so a plain
// OpenAIResponsesModel would break apply_patch + memory generation. Fix: subclass with a
// name containing "ChatCompletions" → those features fall back to ordinary FUNCTION tools
// (which Ollama's Responses endpoint fully supports), while inference still hits /v1/responses.
//
// The OpenAI client is pointed at the user's local Ollama and fetches over LNA (loopback),
// so the browser page reaches the model on the machine.
import { OpenAIResponsesModel, setDefaultModelProvider, setDefaultOpenAIClient, type Model, type ModelProvider } from "@openai/agents";
import { OpenAI } from "openai";
import { S } from "../../../store";
import { providerFor } from "@automo/inference";
import { BrowserModel } from "./browser-model";
import { spaceFor } from "../../net/index";

// Name MUST contain "ChatCompletions" to trip the SDK's transport check.
class ChatCompletionsResponsesModel extends OpenAIResponsesModel {}

// fetch that carries the LNA loopback hint ONLY for local addresses, so requests reach localhost Ollama
// from a public origin. Remote endpoints (HuggingFace router) must NOT get the hint — Chrome rejects a
// loopback-hinted request to a public host, so a always-on hint breaks the remote provider.
const lnaFetch = ((input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (!spaceFor(url)) return fetch(input, init); // public host → plain fetch
  try { return fetch(input, { ...(init || {}), targetAddressSpace: "loopback" }); }
  catch { return fetch(input, init); }
}) as any;

let installedFor = "";
let currentProvider: ModelProvider | null = null; // the same provider the text agent resolves models through
// Install the OpenAI client + model provider for the SELECTED inference backend. vLLM implements the
// native Responses transport, so it gets the real OpenAIResponsesModel (native apply_patch + server
// compaction — the full capability set). Ollama / HuggingFace / anything non-native gets the
// ChatCompletions-named subclass so apply_patch + structured tools fall back to function tools.
export function installModelProvider(model: string) {
  const p = providerFor(S.provider as any, { ollamaUrl: S.url, vllmUrl: S.vllmUrl, hfToken: S.hfToken });
  // In-browser engine: no HTTP endpoint / OpenAI client — the model provider returns a BrowserModel that
  // runs on WebGPU/WASM, so the SandboxAgent drives real local inference. `webllm` uses MLC (stronger
  // chat); `browser` uses transformers.js (ONNX). Both are text-only (no native tool transport).
  if (p.kind === "browser" || p.kind === "webllm") {
    const engineKind = p.kind === "webllm" ? "webllm" : "transformers";
    const key = p.kind + "|" + model;
    if (installedFor === key) return model;
    currentProvider = { getModel(modelName?: string) { return new BrowserModel(modelName || model, engineKind); } };
    setDefaultModelProvider(currentProvider);
    installedFor = key;
    return model;
  }
  const baseURL = p.baseURL || (S.url.replace(/\/$/, "") + "/v1/");
  const key = p.kind + "|" + baseURL + "|" + model;
  if (installedFor === key) return model;
  const apiKey = p.kind === "huggingface" ? (S.hfToken || "hf") : "ollama"; // ignored by local servers
  const client = new OpenAI({ baseURL, apiKey, dangerouslyAllowBrowser: true, fetch: lnaFetch });
  setDefaultOpenAIClient(client as any);
  const native = p.responsesNative;
  currentProvider = {
    getModel(modelName?: string) {
      return native
        ? new OpenAIResponsesModel(client as any, modelName || model)
        : new ChatCompletionsResponsesModel(client as any, modelName || model);
    },
  };
  setDefaultModelProvider(currentProvider);
  if (!native) {
    // sanity: the shim name must trip the SDK check or the fallback is a no-op
    const probe = new ChatCompletionsResponsesModel(client as any, model);
    if (!probe.constructor.name.includes("ChatCompletions")) throw new Error('shim broken: lost "ChatCompletions"');
  }
  installedFor = key;
  return model;
}

// Resolve the SAME provider-aware SDK Model the text agent uses (Ollama shim / vLLM native / Browser).
// The voice transport drives its turns through this — one brain, not a parallel chat implementation.
export async function resolveBrainModel(name?: string): Promise<Model> {
  const model = installModelProvider(name || S.model);
  if (!currentProvider) throw new Error("model provider not installed");
  return currentProvider.getModel(name || model);
}
