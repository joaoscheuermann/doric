import assert from 'node:assert/strict';
import test from 'node:test';

import { createSandbox } from 'sandbox';

import { createDockerClient } from '../src/index.js';

const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
};

const sandbox = () =>
  createSandbox({
    provider: createDockerClient(),
    image: 'node:22-bookworm',
    imagePullPolicy: 'if-not-present',
    resources: { cpuCount: 1, memoryMiB: 512, diskMiB: 4096 },
  });

void test('timeout terminates the remote process and its descendants', {
  timeout: 20_000,
}, async () => {
  const session = await sandbox();
  try {
    if (session.start === undefined)
      throw new Error('Sandbox process provider is unavailable.');

    const process = await session.start({
      cmd: ['sh', '-c', 'sleep 60 & echo $!; wait'],
      timeoutMs: 250,
    });
    const result = await process.result;
    const pid = result.stdout.trim();
    assert.match(pid, /^\d+$/u);
    const status = await session.exec({
      cmd: ['sh', '-c', `ps -o stat= -p ${pid}`],
    });
    assert.match(status.stdout.trim(), /^(Z.*)?$/u);
    const leftovers = await session.exec({
      cmd: ['sh', '-c', 'find /tmp -name "doric-process-*"'],
    });
    assert.equal(leftovers.stdout, '');
  } finally {
    await session.dispose();
  }
});

void test('streams separate output before exit and accepts process input', {
  timeout: 20_000,
}, async () => {
  const session = await sandbox();
  try {
    const ready = deferred();
    let output = '';
    if (session.start === undefined)
      throw new Error('Sandbox process provider is unavailable.');

    const process = await session.start({
      cmd: [
        'sh',
        '-c',
        'printf ready; read line; printf "out:%s" "$line"; printf err >&2',
      ],
      onOutput: ({ data }) => {
        output += data;
        if (output.includes('ready')) ready.resolve();
      },
    });
    await ready.promise;
    await process.write('olá\n');
    const result = await process.result;
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'readyout:olá');
    assert.equal(result.stderr, 'err');
  } finally {
    await session.dispose();
  }
});

void test('resizes a real PTY and sends interrupt keys to its foreground process', {
  timeout: 20_000,
}, async () => {
  const session = await sandbox();
  try {
    const ready = deferred();
    const sized = deferred();
    const running = deferred();
    let output = '';
    if (session.start === undefined)
      throw new Error('Sandbox process provider is unavailable.');

    const process = await session.start({
      cmd: ['bash', '--noprofile', '--norc', '-i'],
      tty: true,
      cols: 80,
      rows: 24,
      timeoutMs: 5_000,
      onOutput: ({ data }) => {
        output += data;
        if (output.includes('# ')) ready.resolve();
        if (output.includes('37 109')) sized.resolve();
        if (output.includes('RUNNING')) running.resolve();
      },
    });
    await ready.promise;
    await process.resize(109, 37);
    await process.write('stty size\n');
    await sized.promise;
    await process.write(
      'exec sh -c \'printf "\\122UNNING\\n"; exec sleep 60\'\n',
    );
    await running.promise;
    await process.write('\x03');
    const result = await process.result;
    assert.equal(result.exitCode, 130);
    assert.match(result.stdout, /37 109/u);
  } finally {
    await session.dispose();
  }
});

void test('termination kills command descendants without disposing the sandbox', {
  timeout: 20_000,
}, async () => {
  const session = await sandbox();
  try {
    const child = deferred<string>();
    let output = '';

    if (session.start === undefined)
      throw new Error('Sandbox process provider is unavailable.');

    const process = await session.start({
      cmd: ['sh', '-c', 'sleep 60 & echo $!; wait'],
      onOutput: ({ data }) => {
        output += data;
        if (output.includes('\n')) child.resolve(output.trim());
      },
    });
    const pid = await child.promise;
    await process.terminate();
    await process.result;
    const status = await session.exec({
      cmd: ['sh', '-c', `ps -o stat= -p ${pid}`],
    });
    assert.match(status.stdout.trim(), /^(Z.*)?$/u);
    assert.equal((await session.exec({ cmd: ['true'] })).exitCode, 0);
  } finally {
    await session.dispose();
  }
});
