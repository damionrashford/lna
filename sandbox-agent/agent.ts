// Non-hosted OpenAI Agents JS SANDBOX AGENT — Responses API against LOCAL Ollama.
//
// Nothing hosted: inference is local Ollama's /v1/responses (added in Ollama 0.13.3),
// execution is local via UnixLocalSandboxClient. The sandbox gives the model a real
// workspace with filesystem + shell (+ skills) capabilities.
//
// Run: OPENAI_AGENTS_DISABLE_TRACING=1 bun agent.ts
import { run, setDefaultOpenAIClient } from '@openai/agents';
import { Capabilities, Manifest, SandboxAgent } from '@openai/agents/sandbox';
import { UnixLocalSandboxClient } from '@openai/agents/sandbox/local';
import { OpenAI } from 'openai';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Point the SDK at local Ollama. Default model API stays the Responses API — Ollama serves it.
setDefaultOpenAIClient(
  new OpenAI({ baseURL: 'http://127.0.0.1:11434/v1/', apiKey: 'ollama' }),
);

const MODEL = process.env.AGENT_MODEL || 'local-agent:latest';

const manifest = new Manifest({
  entries: {
    'task.md': {
      type: 'file',
      content: `# Task
There is a file \`data/numbers.txt\` with one integer per line.
Compute their sum and write ONLY the number to \`result.txt\` in the workspace root.
`,
    },
    'data/numbers.txt': { type: 'file', content: '11\n17\n23\n8\n' }, // sum = 59
  },
});

const agent = new SandboxAgent({
  name: 'Local Sandbox Agent',
  model: MODEL,
  instructions:
    'You work inside a sandbox workspace. Use the shell (exec_command) to inspect and compute. ' +
    'Read task.md, then data/numbers.txt, compute the sum with a shell command, and write ONLY the ' +
    'number to result.txt in the workspace root. Paths are relative to the workspace root. ' +
    'When result.txt is written, reply with the sum and stop.',
  defaultManifest: manifest,
  capabilities: Capabilities.default(), // filesystem + shell + compaction
});

const client = new UnixLocalSandboxClient();
const session = await client.create(manifest);

console.log(`model: ${MODEL}  ·  api: Responses (local Ollama)  ·  client: UnixLocalSandboxClient`);
console.log(`workspace: ${session.state.workspaceRootPath}\n`);

try {
  const result = await run(
    agent,
    'Do the task in task.md now. Compute the sum and write it to result.txt.',
    { sandbox: { session }, maxTurns: 16 },
  );

  const toolCalls = result.newItems
    .filter((i: any) => i.type === 'tool_call_item')
    .map((i: any) => (i.rawItem?.name as string) ?? i.rawItem?.type)
    .filter(Boolean);

  console.log('\n=== RESULT ===');
  console.log('final_output:', result.finalOutput);
  console.log('tool_calls:', toolCalls.join(', ') || '(none)');

  const resultFile = join(session.state.workspaceRootPath, 'result.txt');
  const written = await readFile(resultFile, 'utf8').catch(() => '(result.txt not created)');
  console.log('result.txt on disk:', JSON.stringify(written.trim()));
  console.log(written.trim() === '59' ? '✅ VERIFIED: sandbox computed + wrote 59' : '⚠️ unexpected result');
} finally {
  await session.close?.().catch(() => {});
}
