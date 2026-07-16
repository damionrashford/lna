// FULL-CAPABILITY non-hosted sandbox agent — every built-in capability, local Ollama Responses API.
//
// Capabilities & the tools they expose (all NON-HOSTED, executed by UnixLocalSandboxClient):
//   shell()       → exec_command   (+ write_stdin under a PTY session)
//   filesystem()  → apply_patch, view_image
//   skills()      → load_skill     (discovers local SKILL.md files, lazy-materialized)
//   memory()      → reads memories/ at start, generates memories/ at session close (needs shell + filesystem)
//   compaction()  → no tool; trims context on long runs
//
// Run: OPENAI_AGENTS_DISABLE_TRACING=1 bun full-agent.ts
import { run, setDefaultOpenAIClient } from '@openai/agents';
import {
  Manifest,
  SandboxAgent,
  shell,
  filesystem,
  skills,
  memory,
  compaction,
} from '@openai/agents/sandbox';
import {
  UnixLocalSandboxClient,
  localDirLazySkillSource,
} from '@openai/agents/sandbox/local';
import { OpenAI } from 'openai';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

setDefaultOpenAIClient(
  new OpenAI({ baseURL: 'http://127.0.0.1:11434/v1/', apiKey: 'ollama' }),
);

const MODEL = process.env.AGENT_MODEL || 'local-agent:latest';
const here = dirname(fileURLToPath(import.meta.url));
const skillsDir = join(here, 'skills'); // contains sum-writer/SKILL.md

const manifest = new Manifest({
  entries: {
    'task.md': {
      type: 'file',
      content:
        '# Task\nSum the integers in data/numbers.txt and record the total to result.txt.\n',
    },
    'data/numbers.txt': { type: 'file', content: '11\n17\n23\n8\n' }, // 59
  },
});

const agent = new SandboxAgent({
  name: 'Full-Capability Local Sandbox Agent',
  model: MODEL,
  instructions: [
    'You have shell, filesystem, skills, and memory capabilities in a local sandbox.',
    'Steps for this task:',
    '1. Call load_skill on "sum-writer" to get the recording convention.',
    '2. Use exec_command to read and sum the integers in data/numbers.txt.',
    '3. Use exec_command to write ONLY the total into result.txt in the workspace root.',
    'Then reply with the total and stop. Paths are relative to the workspace root.',
  ].join('\n'),
  defaultManifest: manifest,
  capabilities: [
    shell(), // exec_command
    filesystem(), // view_image; apply_patch needs OpenAI's native Responses transport, which Ollama lacks
    skills({ lazyFrom: localDirLazySkillSource({ src: skillsDir }) }), // load_skill
    memory({ generate: false }), // read-only: memory GENERATION writes via apply_patch, unavailable on Ollama Responses
    compaction(),
  ],
});

const client = new UnixLocalSandboxClient();
const session = await client.create(manifest);
const ws = session.state.workspaceRootPath;

console.log(`model: ${MODEL} · api: Responses (local Ollama) · client: UnixLocalSandboxClient`);
console.log('capabilities: shell, filesystem, skills, memory, compaction');
console.log(`workspace: ${ws}\n`);

try {
  const result = await run(
    agent,
    'Do the task in task.md: load the sum-writer skill, compute the sum, and write it to result.txt.',
    { sandbox: { session }, maxTurns: 24 },
  );

  const toolCalls = result.newItems
    .filter((i: any) => i.type === 'tool_call_item')
    .map((i: any) => (i.rawItem?.name as string) ?? i.rawItem?.type)
    .filter(Boolean);

  console.log('\n=== RESULT ===');
  console.log('final_output:', result.finalOutput);
  console.log('tool_calls:', toolCalls.join(', ') || '(none)');

  const written = await readFile(join(ws, 'result.txt'), 'utf8').catch(() => '(no result.txt)');
  console.log('result.txt:', JSON.stringify(written.trim()));
  console.log(written.trim() === '59' ? '✅ VERIFIED: result.txt = 59' : '⚠️ unexpected result');

  const distinct = [...new Set(toolCalls)];
  console.log('distinct tools exercised:', distinct.join(', '));
} finally {
  // memory() generates memories/ on close; give it a bounded window so the script can't hang.
  await Promise.race([
    session.close?.(),
    new Promise((r) => setTimeout(r, 20000)),
  ]).catch(() => {});
  const mem = await readdir(join(ws, 'memories')).catch(() => []);
  console.log('memories/ after close:', mem.length ? mem.join(', ') : '(none yet)');
}
