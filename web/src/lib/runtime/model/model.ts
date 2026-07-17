// Model provider wiring for the in-browser @openai/agents runtime.
//
// The SDK gates apply_patch / structured-tool / compaction on the native Responses transport, which it
// enables only when the model class name does NOT contain "ChatCompletions". Providers whose
// OpenAI-compatible endpoint lacks that native transport (Ollama, HuggingFace's router) break apply_patch
// and memory generation under a plain OpenAIResponsesModel. Subclassing with a name containing
// "ChatCompletions" forces those features to fall back to function tools (which those endpoints support)
// while inference still hits /v1/responses. vLLM implements the native transport, so it skips the shim
// (see installModelProvider's `native` branch).
import { OpenAIResponsesModel, setDefaultModelProvider, setDefaultOpenAIClient, type Model, type ModelProvider } from "@openai/agents";
import { OpenAI } from "openai";
import { S } from "../../../store";
import { providerFor } from "@automo/inference";
import { BrowserModel } from "./browser-model";
import { spaceFor } from "../../net/index";

// Class name must contain "ChatCompletions" to trip the SDK's transport check. The production minifier
// renames classes, so `constructor.name` loses the substring; pin it via a string literal (which
// minification preserves) so both the SDK's gate and the probe below still see it in the bundled build.
class ChatCompletionsResponsesModel extends OpenAIResponsesModel {}
Object.defineProperty(ChatCompletionsResponsesModel, "name", { value: "ChatCompletionsResponsesModel" });

// fetch that carries the LNA loopback hint only for local addresses, letting a public origin reach a
// local model server (Ollama, vLLM) on localhost. Remote endpoints (HuggingFace router) must not get the
// hint: Chrome rejects a loopback-hinted request to a public host, so an always-on hint would break them.
const lnaFetch = ((input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (!spaceFor(url)) return fetch(input, init); // public host → plain fetch
  try { return fetch(input, { ...(init || {}), targetAddressSpace: "loopback" }); }
  catch { return fetch(input, init); }
}) as any;

let installedFor = "";
let currentProvider: ModelProvider | null = null;
// Install the OpenAI client + model provider for the selected inference backend. vLLM implements the
// native Responses transport, so it gets the real OpenAIResponsesModel (native apply_patch + server
// compaction). Ollama / HuggingFace / anything non-native gets the ChatCompletions-named subclass so
// apply_patch + structured tools fall back to function tools.
export function installModelProvider(model: string) {
  const p = providerFor(S.provider as any, { ollamaUrl: S.url, vllmUrl: S.vllmUrl, hfToken: S.hfToken });
  // In-browser engine: no HTTP endpoint / OpenAI client. The provider returns a BrowserModel that runs on
  // WebGPU/WASM. `webllm` uses MLC; `browser` uses transformers.js (ONNX). Both text-only (no native tool
  // transport).
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
  const apiKey = p.kind === "huggingface" ? (S.hfToken || "hf") : "ollama"; // placeholder; local servers ignore it
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
    // The shim name must trip the SDK check, or the function-tool fallback silently becomes a no-op.
    const probe = new ChatCompletionsResponsesModel(client as any, model);
    if (!probe.constructor.name.includes("ChatCompletions")) throw new Error('shim broken: lost "ChatCompletions"');
  }
  installedFor = key;
  return model;
}

// The provider-aware SDK Model the text agent uses; voice reuses it so both surfaces run on one model.
export async function resolveBrainModel(name?: string): Promise<Model> {
  const model = installModelProvider(name || S.model);
  if (!currentProvider) throw new Error("model provider not installed");
  return currentProvider.getModel(name || model);
}
