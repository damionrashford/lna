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
import { trimUrl } from "../store";

// Name MUST contain "ChatCompletions" to trip the SDK's transport check.
class ChatCompletionsResponsesModel extends OpenAIResponsesModel {}

// fetch that carries the LNA loopback hint so requests reach localhost Ollama from a public origin
const lnaFetch = ((input: any, init?: any) => {
  try { return fetch(input, { ...(init || {}), targetAddressSpace: "loopback" }); }
  catch { return fetch(input, init); }
}) as any;

let installedFor = "";
export function installOllamaShim(model: string) {
  const baseURL = trimUrl() + "/v1/";
  if (installedFor === baseURL + "|" + model) return model;
  const client = new OpenAI({ baseURL, apiKey: "ollama", dangerouslyAllowBrowser: true, fetch: lnaFetch });
  setDefaultOpenAIClient(client as any);
  setDefaultModelProvider({
    getModel(modelName?: string) {
      return new ChatCompletionsResponsesModel(client as any, modelName || model);
    },
  });
  // sanity: the name must trip the check or the shim is a no-op
  const probe = new ChatCompletionsResponsesModel(client as any, model);
  if (!probe.constructor.name.includes("ChatCompletions")) throw new Error('shim broken: lost "ChatCompletions"');
  installedFor = baseURL + "|" + model;
  return model;
}
