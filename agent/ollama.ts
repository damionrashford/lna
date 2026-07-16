// Ollama transport shim for OpenAI Agents JS sandbox agents.
//
// Problem: the SDK gates apply_patch + structured-tool + compaction transports on
//   supportsApplyPatchTransport(m) === !m.constructor.name.includes('ChatCompletions')
// A plain OpenAIResponsesModel therefore claims the NATIVE apply_patch transport, which
// Ollama's /v1/responses does NOT implement — so apply_patch and memory-generation break.
//
// Shim: subclass OpenAIResponsesModel with a name that CONTAINS "ChatCompletions". That
// flips those checks to false, so apply_patch + structured tools register as ordinary
// FUNCTION tools (which Ollama's Responses endpoint fully supports via function calling),
// while inference still hits /v1/responses. Install it as the DEFAULT model provider so the
// agent AND memory's phase models both resolve through the shim.
import {
  OpenAIResponsesModel,
  setDefaultModelProvider,
  setDefaultOpenAIClient,
} from '@openai/agents';
import { OpenAI } from 'openai';

// Class name includes "ChatCompletions" → forces the function-tool fallbacks.
class ChatCompletionsResponsesModel extends OpenAIResponsesModel {}

export function installOllamaShim(opts: {
  model: string;
  baseURL?: string;
  apiKey?: string;
}) {
  const client = new OpenAI({
    baseURL: opts.baseURL ?? 'http://127.0.0.1:11434/v1/',
    apiKey: opts.apiKey ?? 'ollama',
  });
  setDefaultOpenAIClient(client);
  setDefaultModelProvider({
    getModel(modelName?: string) {
      return new ChatCompletionsResponsesModel(client, modelName || opts.model);
    },
  });
  // Sanity: the name must trip the check, or the shim is a no-op.
  const probe = new ChatCompletionsResponsesModel(client, opts.model);
  if (!probe.constructor.name.includes('ChatCompletions')) {
    throw new Error('shim broken: constructor name lost "ChatCompletions"');
  }
  return { client, model: opts.model };
}
