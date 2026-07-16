// FULL capability set WORKING on local Ollama via the transport shim.
// apply_patch + memory-generation now function because the shim forces the function-tool
// fallbacks, while inference stays on Ollama's /v1/responses (non-hosted end to end).
//
// Run: OPENAI_AGENTS_DISABLE_TRACING=1 bun agent-full-shim.ts
import { run } from '@openai/agents';
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
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installOllamaShim } from './ollama-shim.ts';

const MODEL = process.env.AGENT_MODEL || 'local-agent:latest';
installOllamaShim({ model: MODEL });

const here = dirname(fileURLToPath(import.meta.url));
const skillsDir = join(here, 'skills');

const manifest = new Manifest({
  entries: {
    'task.md': {
      type: 'file',
      content: '# Task\nSum the integers in data/numbers.txt, then record the total to result.txt.\n',
    },
    'data/numbers.txt': { type: 'file', content: '11\n17\n23\n8\n' }, // 59
  },
});

const agent = new SandboxAgent({
  name: 'Full Local Sandbox Agent (shimmed)',
  model: MODEL,
  instructions: [
    'You have shell, filesystem, skills, and memory in a local sandbox.',
    '1. Call load_skill on "sum-writer".',
    '2. Use exec_command to sum the integers in data/numbers.txt.',
    '3. Use apply_patch to create result.txt in the workspace root containing ONLY the total.',
    'Then reply with the total and stop. Paths are workspace-root-relative.',
  ].join('\n'),
  defaultManifest: manifest,
  capabilities: [
    shell(),
    filesystem(), // apply_patch now registers as a function tool (shim)
    skills({ lazyFrom: localDirLazySkillSource({ src: skillsDir }) }),
    memory({ generate: { phaseOneModel: MODEL, phaseTwoModel: MODEL } }), // local memory models via shim
    compaction(),
  ],
});

const client = new UnixLocalSandboxClient();
const session = await client.create(manifest);
const ws = session.state.workspaceRootPath;
console.log(`model: ${MODEL} · api: Responses (shimmed→function tools) · client: UnixLocalSandboxClient`);
console.log(`workspace: ${ws}\n`);

try {
  const result = await run(
    agent,
    'Do task.md: load the sum-writer skill, compute the sum, and apply_patch result.txt with the total.',
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
  const distinct = [...new Set(toolCalls)];
  console.log('distinct tools:', distinct.join(', '));
  console.log('apply_patch fired:', distinct.includes('apply_patch') ? '✅' : '❌');
  console.log('result correct:', written.trim() === '59' ? '✅ 59' : `⚠️ ${written.trim()}`);
} finally {
  await Promise.race([session.close?.(), new Promise((r) => setTimeout(r, 45000))]).catch(() => {});
  const mem = await readdir(join(ws, 'memories')).catch(() => []);
  console.log('memories/ after close:', mem.length ? mem.join(', ') : '(none)');
}
