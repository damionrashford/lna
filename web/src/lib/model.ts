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
import { OpenAIResponsesModel, setDefaultModelProvider, setDefaultOpenAIClient } from "@openai/agents";
import { OpenAI } from "openai";
import { S } from "../store";
import { providerFor } from "@automo/inference";
import { BrowserModel } from "./browser-model";

// Name MUST contain "ChatCompletions" to trip the SDK's transport check.
class ChatCompletionsResponsesModel extends OpenAIResponsesModel {}

// fetch that carries the LNA loopback hint so requests reach localhost Ollama from a public origin
const lnaFetch = ((input: any, init?: any) => {
  try { return fetch(input, { ...(init || {}), targetAddressSpace: "loopback" }); }
  catch { return fetch(input, init); }
}) as any;

let installedFor = "";
// Install the OpenAI client + model provider for the SELECTED inference backend. vLLM implements the
// native Responses transport, so it gets the real OpenAIResponsesModel (native apply_patch + server
// compaction — the full capability set). Ollama / HuggingFace / anything non-native gets the
// ChatCompletions-named subclass so apply_patch + structured tools fall back to function tools.
export function installModelProvider(model: string) {
  const p = providerFor(S.provider as any, { ollamaUrl: S.url, vllmUrl: S.vllmUrl, hfToken: S.hfToken });
  // In-browser engine: no HTTP endpoint / OpenAI client — the model provider returns a BrowserModel that
  // runs transformers.js on WebGPU/WASM, so the SandboxAgent drives real local inference (text-only).
  if (p.kind === "browser") {
    const key = "browser|" + model;
    if (installedFor === key) return model;
    setDefaultModelProvider({ getModel(modelName?: string) { return new BrowserModel(modelName || model); } });
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
  setDefaultModelProvider({
    getModel(modelName?: string) {
      return native
        ? new OpenAIResponsesModel(client as any, modelName || model)
        : new ChatCompletionsResponsesModel(client as any, modelName || model);
    },
  });
  if (!native) {
    // sanity: the shim name must trip the SDK check or the fallback is a no-op
    const probe = new ChatCompletionsResponsesModel(client as any, model);
    if (!probe.constructor.name.includes("ChatCompletions")) throw new Error('shim broken: lost "ChatCompletions"');
  }
  installedFor = key;
  return model;
}
