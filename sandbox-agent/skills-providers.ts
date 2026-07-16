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
import { readdir, readFile } from 'node:fs/promises';
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
    repo: 'damionrashford/lna',
    ref: 'main',
    subpath: '.agents/skills',
  }),
};

// Skills pulled FROM GitHub: damionrashford/lna .agents/skills, cloned on load_skill.
const agent = new SandboxAgent({
  name: 'GitHub Skills Agent',
  model: MODEL,
  instructions:
    'Call load_skill on "sum-writer" (served from the lna GitHub repo). After it loads, open its SKILL.md and reply with the description line from the frontmatter, then stop.',
  defaultManifest: new Manifest({ entries: { 'README.md': { type: 'file', content: '# github skills demo\n' } } }),
  capabilities: [
    shell(),
    filesystem(),
    skills({
      lazyFrom: {
        source: SKILL_SOURCES.github,
        index: [{ name: 'sum-writer', description: 'Compute a sum and write it to result.txt (from the lna repo).' }],
      },
      skillsPath: '.agents/github',
    }),
  ],
});

const client = new UnixLocalSandboxClient();
const session = await client.create(agent.defaultManifest as Manifest);
const ws = session.state.workspaceRootPath;
console.log(`model: ${MODEL} · skills from github.com/damionrashford/lna .agents/skills\nworkspace: ${ws}\n`);

try {
  const result = await run(agent, 'Load the sum-writer skill from GitHub and report its description.', { sandbox: { session }, maxTurns: 8 });
  console.log('=== agent output ===');
  console.log(result.finalOutput);
  // Prove the GitHub clone landed on disk:
  const cloned = await readdir(join(ws, '.agents/github')).catch(() => []);
  console.log('\n.agents/github/ (cloned from GitHub):', cloned.length ? cloned.join(', ') : '(nothing — load_skill not called)');
  const skillMd = await readFile(join(ws, '.agents/github/sum-writer/SKILL.md'), 'utf8').catch((e) => `not materialized: ${e.message}`);
  console.log('cloned sum-writer/SKILL.md first line:', skillMd.split('\n').slice(0, 3).join(' | '));
} finally {
  await Promise.race([session.close?.(), new Promise((r) => setTimeout(r, 8000))]).catch(() => {});
}
