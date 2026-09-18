import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import pino from 'pino';

import {
  createSandbox,
  type SandboxExecResult,
  type SandboxSession,
  type SandboxSshAccess,
} from 'sandbox';
import { createSandpool } from 'sandpool';

import { createDockerClient, type DockerClient } from '../src/index.js';

const timeoutMs = 20_000;
const run = promisify(execFile);

const network = {
  mode: 'disabled',
  ssh: true,
  dnsServers: ['1.1.1.1'],
} as const;

test.before(async () => {
  const docker = createDockerClient({ timeoutMs });

  await reachable(docker);

  const sandbox = await createSandbox({
    provider: docker,
    image: 'node:22-slim',
    imagePullPolicy: 'if-not-present',
    resources: { cpuCount: 1, memoryMiB: 512, diskMiB: 4096 },
    timeoutMs,
  });

  await sandbox.dispose();
});

test('executes, transfers bytes, filters egress, and exposes strict SSH', async () => {
  const docker = createDockerClient({ timeoutMs });
  let sandbox: SandboxSession | undefined;

  await reachable(docker);

  try {
    sandbox = await createSandbox({
      provider: docker,
      image: 'node:22-slim',
      imagePullPolicy: 'if-not-present',
      resources: { cpuCount: 1, memoryMiB: 512, diskMiB: 4096 },
      network,
      timeoutMs,
    });

    const probe = succeeded(
      await sandbox.exec({
        cmd: [
          'node',
          '-e',
          'console.log(JSON.stringify({version:process.version,cwd:process.cwd()}))',
        ],
        timeoutMs,
      }),
    );
    const parsed = JSON.parse(probe.stdout) as { version: string; cwd: string };

    assert.match(parsed.version, /^v\d+\./u);

    assert.equal(parsed.cwd, '/workspace');

    await sandbox.writeFile('notes/message.txt', 'hello\n');

    assert.equal(
      await sandbox.readFile('/workspace/notes/message.txt'),
      'hello\n',
    );

    const bytes = Uint8Array.from([0, 1, 2, 127, 128, 254, 255]);

    await sandbox.putFile('/workspace/payload.bin', bytes);

    assert.deepEqual(await sandbox.getFile('/workspace/payload.bin'), bytes);

    const publicHttps = succeeded(
      await sandbox.exec({
        cmd: [
          'node',
          '-e',
          "fetch('https://registry-1.docker.io/v2/').then(r=>console.log(r.status))",
        ],
        timeoutMs,
      }),
    );

    assert.match(publicHttps.stdout, /^\d{3}\s*$/u);

    const metadata = succeeded(
      await sandbox.exec({
        cmd: [
          'node',
          '-e',
          "const s=require('net').connect(80,'169.254.169.254',()=>{console.log('open');s.destroy()});s.setTimeout(1000,()=>{console.log('blocked');s.destroy()});s.on('error',()=>console.log('blocked'))",
        ],
        timeoutMs: 5_000,
      }),
    );

    assert.doesNotMatch(metadata.stdout, /open/u);

    assert.match(metadata.stdout, /blocked/u);

    const ssh = await sandbox.ssh();

    assert.ok(ssh);

    await verifyStrictSsh(ssh);
  } finally {
    await sandbox?.dispose();
  }
});

test('warms, leases, replaces, and shuts down Docker sandboxes', async () => {
  const docker = createDockerClient({ timeoutMs });

  await reachable(docker);

  const pool = createSandpool({
    minIdle: 1,
    maxSandboxes: 1,
    logger: pino({ enabled: false }),
    create: () =>
      createSandbox({
        provider: docker,
        image: 'node:22-slim',
        imagePullPolicy: 'if-not-present',
        resources: { cpuCount: 1, memoryMiB: 512, diskMiB: 4096 },
        timeoutMs,
      }),
  });

  try {
    await pool.waitUntilHeated();

    const first = await pool.acquire();

    const blocked = succeeded(
      await first.sandbox.exec({
        cmd: [
          'node',
          '-e',
          "fetch('https://example.com').then(()=>process.exit(1)).catch(()=>console.log('blocked'))",
        ],
        timeoutMs: 5_000,
      }),
    );

    assert.match(blocked.stdout, /blocked/u);

    await first.release();

    await pool.waitUntilHeated();

    const second = await pool.acquire();

    assert.notEqual(second.sandbox.id, first.sandbox.id);

    await second.release();
  } finally {
    await pool.dispose();
  }

  assert.equal(pool.status().lifecycle, 'disposed');

  assert.equal(pool.status().total, 0);
});

async function reachable(docker: DockerClient): Promise<void> {
  try {
    await docker.ping({ timeoutMs });
  } catch (cause) {
    throw new Error(
      'Docker daemon is unreachable. Start Docker and rerun `npx nx run docker:e2e`.',
      { cause },
    );
  }
}

const succeeded = (result: SandboxExecResult): SandboxExecResult => {
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);

  return result;
};

const verifyStrictSsh = async (ssh: SandboxSshAccess): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), 'doric-docker-ssh-'));

  try {
    const key = join(directory, 'id_ed25519');
    const knownHosts = join(directory, 'known_hosts');

    await writeFile(key, ssh.privateKey, { mode: 0o600 });

    await chmod(key, 0o600);

    await writeFile(knownHosts, `${ssh.knownHosts}\n`, { mode: 0o600 });

    const result = await run(
      'ssh',
      [
        '-T',
        '-i',
        key,
        '-p',
        String(ssh.port),
        '-o',
        'BatchMode=yes',
        '-o',
        'IdentitiesOnly=yes',
        '-o',
        'StrictHostKeyChecking=yes',
        '-o',
        `UserKnownHostsFile=${knownHosts}`,
        `${ssh.username}@${ssh.host}`,
        'node -p process.version',
      ],
      { timeout: 10_000 },
    );

    assert.match(result.stdout, /^v22\./u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};
