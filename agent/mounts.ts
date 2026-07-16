// Every sandbox MOUNT provider — wired, with the backend truth stated.
//
// A mount exposes external storage inside the sandbox workspace. Mounts are EPHEMERAL
// (not copied into snapshots). Each mount pairs a mount ENTRY (what storage) with a
// mount STRATEGY (how a backend attaches it), and backend support is EXPLICIT:
//
//   UnixLocalSandboxClient → localBindMountStrategy()  ONLY  (bind an absolute host path)
//   DockerSandboxClient    → inContainerMountStrategy() (rclone/mount-s3/blobfuse2 in image),
//                            dockerVolumeMountStrategy(), local bind
//   Hosted providers       → provider-specific bucket strategies (Modal/Cloudflare/Blaxel/…)
//
// The SDK FAILS EARLY if a client can't enforce a mount — so cloud buckets can't go in a
// UnixLocal manifest. Below: the local bind mount is verified non-hosted; the cloud mounts
// are exported as ready-to-use config for a Docker/hosted backend (+ credentials).
import {
  Manifest,
  file,
  mount,
  s3Mount,
  gcsMount,
  r2Mount,
  azureBlobMount,
  boxMount,
  s3FilesMount,
  localBindMountStrategy,
  inContainerMountStrategy,
  dockerVolumeMountStrategy,
} from '@openai/agents/sandbox';
import { UnixLocalSandboxClient } from '@openai/agents/sandbox/local';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---- (A) LOCAL BIND MOUNT — supported by UnixLocalSandboxClient (verified below) ----
const hostMountDir = await mkdtemp(join(tmpdir(), 'lna-mount-'));
await writeFile(join(hostMountDir, 'secret.txt'), 'bound live from the host\n');

const localBind = mount({
  source: hostMountDir, // absolute host path
  mountPath: 'bound', // appears at <workspace>/bound
  // A local bind is a SYMLINK, so read-only can't be enforced — must be explicitly false.
  // Use Docker/hosted for enforced read-only mounts.
  readOnly: false,
  mountStrategy: localBindMountStrategy(),
});

// ---- (B) CLOUD MOUNT PROVIDERS — for Docker/hosted backends (+ credentials) ----
// Exported as reference config. Each pairs a bucket entry with a container/volume strategy.
export const CLOUD_MOUNTS = {
  s3: s3Mount({
    bucket: 'my-bucket', prefix: 'data/', region: 'us-east-1',
    mountPath: 'data/s3', readOnly: true, mountStrategy: inContainerMountStrategy(),
  }),
  gcs: gcsMount({
    bucket: 'my-bucket', prefix: 'data/',
    mountPath: 'data/gcs', readOnly: true, mountStrategy: inContainerMountStrategy(),
  }),
  r2: r2Mount({
    bucket: 'my-bucket', endpointUrl: 'https://ACCOUNT.r2.cloudflarestorage.com',
    mountPath: 'data/r2', readOnly: true, mountStrategy: inContainerMountStrategy(),
  }),
  azureBlob: azureBlobMount({
    bucket: 'my-container', endpointUrl: 'https://ACCOUNT.blob.core.windows.net',
    mountPath: 'data/azure', readOnly: true, mountStrategy: inContainerMountStrategy(),
  } as any),
  box: boxMount({
    mountPath: 'data/box', readOnly: true, mountStrategy: inContainerMountStrategy(),
  }),
  s3Files: s3FilesMount({
    bucket: 'my-bucket', region: 'us-east-1',
    mountPath: 'data/s3files', readOnly: true, mountStrategy: inContainerMountStrategy(),
  } as any),
  // Docker-volume alternative (no rclone in image): a named/driver-backed volume.
  dockerVolume: mount({ mountPath: 'data/vol', mountStrategy: dockerVolumeMountStrategy() }),
};

// ---- verify the local bind mount materializes non-hosted ----
const manifest = new Manifest({
  entries: {
    'README.md': file({ content: '# mounts demo\n' }),
    bound: localBind,
  },
});

const client = new UnixLocalSandboxClient();
const session = await client.create(manifest);
const ws = session.state.workspaceRootPath;
console.log(`client: UnixLocalSandboxClient\nworkspace: ${ws}`);
console.log(`cloud mount configs wired: ${Object.keys(CLOUD_MOUNTS).join(', ')} (need Docker/hosted + creds)\n`);

try {
  const listed = await readdir(join(ws, 'bound')).catch((e) => [`ERR: ${e.message}`]);
  const content = await readFile(join(ws, 'bound', 'secret.txt'), 'utf8').catch((e) => `ERR: ${e.message}`);
  console.log('=== local bind mount ===');
  console.log('bound/ contents:', listed);
  console.log('bound/secret.txt:', JSON.stringify(content.trim()));
  console.log(content.includes('bound live from the host') ? '✅ VERIFIED: host path bound into the sandbox' : '⚠️ bind not materialized');
} finally {
  await session.close?.().catch(() => {});
  await rm(hostMountDir, { recursive: true, force: true }).catch(() => {});
}
