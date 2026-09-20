import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import pino from 'pino';

import { createSandbox, type SandboxSession } from 'sandbox';
import { createSandpool } from 'sandpool';

import {
  createFirecrackerClient,
  DEFAULT_FIRECRACKER_PATHS,
  nodeTransport,
  preflightFirecrackerHost,
} from '../src/index.js';

const run = promisify(execFile);
const resources = { cpuCount: 1, memoryMiB: 512, diskMiB: 4096 } as const;

const network = {
  mode: 'disabled',
  ssh: true,
  dnsServers: ['1.1.1.1'],
} as const;

test.before(async () => {
  await preflightFirecrackerHost({
    paths: DEFAULT_FIRECRACKER_PATHS,
    networkPool: '10.231.0.0/16',
    cacheLimitBytes: 20 * 1024 ** 3,
    readinessTimeoutMs: 30_000,
    jailerUid: 0,
    jailerGid: 0,
    transport: nodeTransport,
  });
});

test(
  'runs node, transfers bytes, filters egress, and exposes strict SSH',
  { timeout: 10 * 60_000 },
  async () => {
    let sandbox: SandboxSession | undefined;

    try {
      sandbox = await createSandbox({
        provider: createFirecrackerClient(),
        image: 'node:22-slim',
        imagePullPolicy: 'if-not-present',
        resources,
        network,
      });

      const node = await sandbox.exec({
        cmd: ['node', '-p', 'JSON.stringify([process.version,process.cwd()])'],
        timeoutMs: 10_000,
      });

      assert.equal(node.exitCode, 0, node.stderr);

      const [version, cwd] = JSON.parse(node.stdout) as [string, string];

      assert.match(version, /^v22\./u);

      assert.equal(cwd, '/workspace');

      const bytes = Uint8Array.from([0, 1, 2, 127, 128, 254, 255]);

      await sandbox.putFile('/workspace/payload.bin', bytes);

      assert.deepEqual(await sandbox.getFile('/workspace/payload.bin'), bytes);

      const publicHttps = await sandbox.exec({
        cmd: [
          'node',
          '-e',
          "fetch('https://registry-1.docker.io/v2/').then(r=>console.log(r.status))",
        ],
        timeoutMs: 20_000,
      });

      assert.equal(publicHttps.exitCode, 0, publicHttps.stderr);

      assert.match(publicHttps.stdout, /^\d{3}\s*$/u);

      const metadata = await sandbox.exec({
        cmd: [
          'node',
          '-e',
          "const s=require('net').connect(80,'169.254.169.254',()=>{console.log('open');s.destroy()});s.setTimeout(1000,()=>{console.log('blocked');s.destroy()});s.on('error',()=>console.log('blocked'))",
        ],
        timeoutMs: 5_000,
      });

      assert.equal(metadata.exitCode, 0, metadata.stderr);

      assert.doesNotMatch(metadata.stdout, /open/u);

      assert.match(metadata.stdout, /blocked/u);

      const ssh = await sandbox.ssh();

      assert.ok(ssh);

      const directory = await mkdtemp(join(tmpdir(), 'doric-ssh-'));

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
    } finally {
      await sandbox?.dispose();
    }
  },
);

test(
  'warms, isolates, replaces, and shuts down Firecracker sandboxes',
  { timeout: 15 * 60_000 },
  async () => {
    const provider = createFirecrackerClient();

    const pool = createSandpool({
      minIdle: 1,
      maxSandboxes: 1,
      logger: pino({ enabled: false }),
      create: () =>
        createSandbox({
          provider,
          image: 'node:22-slim',
          imagePullPolicy: 'if-not-present',
          resources,
        }),
    });

    try {
      await pool.waitUntilHeated();

      const first = await pool.acquire();

      await first.sandbox.writeFile('isolated.txt', 'first');

      await first.release();

      await pool.waitUntilHeated();

      const second = await pool.acquire();

      assert.notEqual(second.sandbox.id, first.sandbox.id);

      const isolated = await second.sandbox.exec({
        cmd: [
          'node',
          '-e',
          "process.exit(require('fs').existsSync('/workspace/isolated.txt')?1:0)",
        ],
      });

      assert.equal(isolated.exitCode, 0, isolated.stderr);

      await second.release();
    } finally {
      await pool.dispose();
    }

    assert.equal(pool.status().lifecycle, 'disposed');

    assert.equal(pool.status().total, 0);
  },
);
