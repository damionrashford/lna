// Skills pulled FROM GitHub — the lna repo's .agents/skills, cloned on load_skill.
// A skill is a FOLDER: SKILL.md (frontmatter name+description) + optional scripts/, references/, assets/.
import { run } from '@openai/agents';
import { Manifest, SandboxAgent, shell, filesystem, skills, gitRepo } from '@openai/agents/sandbox';
import { UnixLocalSandboxClient } from '@openai/agents/sandbox/local';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { installOllamaShim } from './ollama.ts';

const MODEL = process.env.AGENT_MODEL || 'local-agent:latest';
installOllamaShim({ model: MODEL });

export const githubSkills = gitRepo({
  host: 'github.com',
  repo: 'damionrashford/lna',
  ref: 'main',
  subpath: '.agents/skills',
});

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
        source: githubSkills,
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
  const cloned = await readdir(join(ws, '.agents/github')).catch(() => []);
  console.log('\n.agents/github/ (cloned from GitHub):', cloned.length ? cloned.join(', ') : '(nothing — load_skill not called)');
  const skillMd = await readFile(join(ws, '.agents/github/sum-writer/SKILL.md'), 'utf8').catch((e: any) => `not materialized: ${e.message}`);
  console.log('cloned sum-writer/SKILL.md first line:', skillMd.split('\n').slice(0, 3).join(' | '));
} finally {
  await Promise.race([session.close?.(), new Promise((r) => setTimeout(r, 8000))]).catch(() => {});
}
