// Every skill provider the Agents SDK sandbox allows — enabled and documented.
//
// A SKILL IS A FOLDER, not a file: SKILL.md (frontmatter name+description) + optional
// scripts/, references/, assets/. The SDK's own discovery prompt says: open SKILL.md, then
// load only the referenced files under references/, and prefer running/patching scripts/.
//
// SkillsArgs = {
//   skills?:   SkillDescriptor[]          // (1) INLINE — folder defined in code (content + scripts + references + assets)
//   from?:     Entry                      // (2) EAGER  — a dir()/localDir()/gitRepo() placed at skillsPath, all discovered up front
//   lazyFrom?: { source, index, getIndex} // (3) LAZY   — a dir()/localDir()/gitRepo() materialized on demand via load_skill
//   index?:    SkillIndexEntry[]
//   skillsPath?: string                   // default ".agents"  → skills live at .agents/<name>/SKILL.md
// }
//
// The three SOURCE types (each usable as `from` eager OR inside `lazyFrom` lazy):
//   dir({ children })                     — synthetic, in-manifest
//   localDir({ src })                     — a host directory of skill folders
//   gitRepo({ host, repo, ref, subpath }) — a git/GitHub repo of skill folders
import { run } from '@openai/agents';
import {
  Manifest,
  SandboxAgent,
  shell,
  filesystem,
  skills,
  file,
  dir,
  localDir,
  gitRepo,
} from '@openai/agents/sandbox';
import { UnixLocalSandboxClient } from '@openai/agents/sandbox/local';
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installOllamaShim } from './ollama-shim.ts';

const MODEL = process.env.AGENT_MODEL || 'local-agent:latest';
installOllamaShim({ model: MODEL });

const here = dirname(fileURLToPath(import.meta.url));
const localSkillsDir = join(here, 'skills'); // contains sum-writer/SKILL.md

// (1) INLINE provider — a skill folder authored in code, WITH a script.
const inlineGreet = {
  name: 'greet',
  description: 'Greets by running its bundled script.',
  content:
    '---\nname: greet\ndescription: Greets by running scripts/greet.sh.\n---\n# Greet\nRun `scripts/greet.sh` and report its output.',
  scripts: {
    'greet.sh': file({ content: '#!/usr/bin/env bash\necho "hello from a skill script"\n' }),
  },
};

// (2)/(3) The three SOURCE providers, ready to drop into `from:` (eager) or `lazyFrom.source` (lazy).
export const SKILL_SOURCES = {
  syntheticDir: dir({
    children: {
      'echo-note': {
        type: 'dir',
        children: {
          'SKILL.md': file({
            content:
              '---\nname: echo-note\ndescription: Writes a note file.\n---\n# Echo Note\nUse the shell to write notes/echo.txt.',
          }),
        },
      },
    },
  }),
  hostDir: localDir({ src: localSkillsDir }),
  github: gitRepo({
    host: 'github.com',
    repo: 'openai/openai-agents-js',
    ref: 'main',
    subpath: 'examples/docs/sandbox-agents/skills',
  }),
};

// Verified agent: INLINE provider + LAZY local-dir provider (sum-writer). The GitHub provider is
// wired as an alternate lazy source below — lazy means it only clones when load_skill is called.
const agent = new SandboxAgent({
  name: 'Skill Providers Agent',
  model: MODEL,
  instructions:
    'List EVERY skill available to you by name (from the injected skill index), one per line, then stop. Do not call any tools.',
  defaultManifest: new Manifest({ entries: { 'README.md': { type: 'file', content: '# skills demo\n' } } }),
  // One provider per skills() capability (SDK rule); combine providers by stacking
  // capabilities with DISTINCT skillsPaths so they don't clobber each other.
  capabilities: [
    shell(),
    filesystem(),
    skills({ skills: [inlineGreet], skillsPath: '.agents/inline' }), // (1) inline provider
    skills({
      lazyFrom: { source: SKILL_SOURCES.hostDir, index: [{ name: 'sum-writer', description: 'Write a computed sum to result.txt.' }] },
      skillsPath: '.agents/local',
    }), // (2) local-dir provider (lazy)
    skills({
      lazyFrom: { source: SKILL_SOURCES.github, index: [{ name: 'invoice-total-fixer', description: 'Fix invoice totals — cloned from GitHub on load_skill.' }] },
      skillsPath: '.agents/github',
    }), // (3) GitHub provider (lazy — clones only on load_skill)
  ],
});

const client = new UnixLocalSandboxClient();
const session = await client.create(agent.defaultManifest as Manifest);
const ws = session.state.workspaceRootPath;
console.log(`model: ${MODEL} · providers wired: inline, local-dir(lazy) + github(alt)\nworkspace: ${ws}\n`);

try {
  const result = await run(agent, 'What skills do you have?', { sandbox: { session }, maxTurns: 8 });
  console.log('=== agent sees these skills ===');
  console.log(result.finalOutput);
  const agents = await readdir(join(ws, '.agents')).catch(() => []);
  console.log('\n.agents/ materialized:', agents.length ? agents.join(', ') : '(lazy — nothing until load_skill)');
} finally {
  await Promise.race([session.close?.(), new Promise((r) => setTimeout(r, 8000))]).catch(() => {});
}
