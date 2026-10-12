import assert from 'node:assert/strict';
import test from 'node:test';

import { createDockerClient } from 'docker-sandbox';
import { createSandbox } from 'sandbox';

import { createTerminalRegistry } from '../src/host/registry.js';

/*
 * The registry against a real Docker sandbox (DORIC_TEST_SANDBOX=true): an
 * agent command's result, and a manual bash PTY whose typed command is
 * tracked through OSC 633;E and whose output is redacted.
 */

const enabled = process.env.DORIC_TEST_SANDBOX === 'true';

const waitFor = async (check: () => boolean, timeoutMs = 15_000) => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out.');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

void test('runs agent commands and manual shells in a Docker sandbox', {
  skip: enabled ? false : 'Requires DORIC_TEST_SANDBOX=true',
  timeout: 60_000,
}, async () => {
  const session = await createSandbox({
    provider: createDockerClient(),
    image: 'node:22-bookworm',
    imagePullPolicy: 'if-not-present',
    resources: { cpuCount: 1, memoryMiB: 512, diskMiB: 4096 },
  });
  const registry = createTerminalRegistry(
    () => undefined,
    () => ['hunter2'],
  );
  try {
    const agent = await registry.start({
      sandbox: session,
      projectId: 'p',
      threadId: 't',
      origin: 'agent',
      input: {
        command: 'echo done; echo hunter2 >&2',
        cwd: '/workspace',
        timeoutMs: 10_000,
      },
    });
    const result = await agent.result;
    assert.equal(result.reason, 'exited');
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), 'done');
    assert.equal(registry.list('p').length, 0);

    const manual = await registry.start({
      sandbox: session,
      projectId: 'p',
      threadId: 't',
      origin: 'user',
      input: { command: 'bash', cwd: '/workspace', timeoutMs: 0, pty: true },
      cols: 100,
      rows: 30,
    });
    const id = manual.terminal.id;
    await waitFor(() => registry.snapshot(id)?.terminal.state === 'running');
    assert.equal(await registry.input(id, 'echo hunter2-$((40 + 2))\r'), true);
    await waitFor(() => (registry.snapshot(id)?.output ?? '').includes('-42'));
    const snapshot = registry.snapshot(id);
    assert.ok(snapshot);
    assert.equal(snapshot.output.includes('hunter2'), false);
    assert.match(snapshot.output, /\[REDACTED\]-42/u);
    assert.equal(snapshot.output.includes('\u001b]633;E;'), false);
    await waitFor(() => registry.snapshot(id)?.terminal.command === 'bash');
    assert.equal(await registry.resize(id, 120, 40), true);
    assert.equal(await registry.stop(id), true);
    assert.equal(registry.list('p').length, 0);
  } finally {
    await session.dispose();
  }
});
