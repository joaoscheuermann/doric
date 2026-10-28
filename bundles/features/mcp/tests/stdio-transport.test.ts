// The SDK transport over a sandbox process: newline-delimited JSON-RPC both
// ways, one start, one close notice whatever ends the process, and stderr
// lines with every secret redacted.

import assert from 'node:assert/strict';
import test from 'node:test';

import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type {
  SandboxExecResult,
  SandboxProcess,
  SandboxProcessOutput,
} from 'sandbox';

import {
  createSandboxStdioTransport,
  type StartProcess,
} from '../src/host/stdio.js';
import { deferred, eventually } from './support/wait.js';

const resultOf = (exitCode: number | null): SandboxExecResult => ({
  exitCode,
  stdout: '',
  stderr: '',
  stdoutBytes: new Uint8Array(),
  stderrBytes: new Uint8Array(),
});

/** A process double: what was written, what it emits, how it ends. */
const fakeProcess = () => {
  const writes: string[] = [];
  const result = deferred<SandboxExecResult>();
  let onOutput: ((output: SandboxProcessOutput) => void) | undefined;
  let starts = 0;
  let terminations = 0;

  const process: SandboxProcess = {
    result: result.promise,
    write: async (data) => {
      writes.push(data);
    },
    resize: async () => undefined,
    terminate: async () => {
      terminations += 1;
      result.resolve(resultOf(null));
    },
  };

  const start: StartProcess = async (listener) => {
    starts += 1;
    onOutput = listener;
    return process;
  };

  return {
    start,
    writes,
    emit: (output: SandboxProcessOutput) => onOutput?.(output),
    exit: (exitCode: number) => result.resolve(resultOf(exitCode)),
    get starts() {
      return starts;
    },
    get terminations() {
      return terminations;
    },
  };
};

const ping: JSONRPCMessage = { jsonrpc: '2.0', id: 1, method: 'ping' };
const pong: JSONRPCMessage = { jsonrpc: '2.0', id: 1, result: {} };

void test('start launches the process once; a second start rejects', async () => {
  const fake = fakeProcess();
  const transport = createSandboxStdioTransport({
    start: fake.start,
    secrets: [],
  });

  await transport.start();

  await assert.rejects(transport.start());

  assert.equal(fake.starts, 1);

  await transport.close();
});

void test('send writes the message as one JSON line', async () => {
  const fake = fakeProcess();
  const transport = createSandboxStdioTransport({
    start: fake.start,
    secrets: [],
  });
  await transport.start();

  await transport.send(ping);

  assert.equal(fake.writes.join(''), `${JSON.stringify(ping)}\n`);

  await transport.close();
});

void test('complete stdout lines reach onmessage, even when split across chunks or sharing one', async () => {
  const fake = fakeProcess();
  const transport = createSandboxStdioTransport({
    start: fake.start,
    secrets: [],
  });
  const received: JSONRPCMessage[] = [];
  transport.onmessage = (message) => {
    received.push(message);
  };
  await transport.start();
  const line = JSON.stringify(pong);

  fake.emit({ stream: 'stdout', data: line.slice(0, 10) });

  assert.deepEqual(received, []);

  fake.emit({ stream: 'stdout', data: `${line.slice(10)}\n${line}\n` });
  await eventually(
    () => received.length >= 2,
    'two messages',
    () => received,
  );

  assert.deepEqual(received, [pong, pong]);

  await transport.close();
});

void test('a stdout line that does not parse reaches onerror, not onmessage', async () => {
  const fake = fakeProcess();
  const transport = createSandboxStdioTransport({
    start: fake.start,
    secrets: [],
  });
  const received: JSONRPCMessage[] = [];
  const errors: Error[] = [];
  transport.onmessage = (message) => {
    received.push(message);
  };
  transport.onerror = (error) => {
    errors.push(error);
  };
  await transport.start();

  fake.emit({ stream: 'stdout', data: 'starting server...\n' });
  await eventually(
    () => errors.length > 0,
    'an error',
    () => received,
  );

  assert.deepEqual(received, []);

  assert.equal(errors.length, 1);

  await transport.close();
});

void test('close terminates the process and onclose runs once', async () => {
  const fake = fakeProcess();
  const transport = createSandboxStdioTransport({
    start: fake.start,
    secrets: [],
  });
  let closed = 0;
  transport.onclose = () => {
    closed += 1;
  };
  await transport.start();

  await transport.close();
  await eventually(() => closed > 0, 'onclose');
  fake.exit(0);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fake.terminations, 1);

  assert.equal(closed, 1);
});

void test('a process that exits on its own runs onclose once', async () => {
  const fake = fakeProcess();
  const transport = createSandboxStdioTransport({
    start: fake.start,
    secrets: [],
  });
  let closed = 0;
  transport.onclose = () => {
    closed += 1;
  };
  await transport.start();

  fake.exit(1);
  await eventually(() => closed > 0, 'onclose');
  await transport.close();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(closed, 1);
});

void test('stderr lines reach onStderr with every secret redacted', async () => {
  const fake = fakeProcess();
  const lines: string[] = [];
  const transport = createSandboxStdioTransport({
    start: fake.start,
    secrets: ['alpha-secret', 'beta-secret'],
    onStderr: (line) => {
      lines.push(line);
    },
  });
  await transport.start();

  fake.emit({
    stream: 'stderr',
    data: 'using alpha-secret and beta-secret\nagain alpha-secret\n',
  });

  await eventually(
    () => lines.length >= 2,
    'two stderr lines',
    () => lines,
  );

  assert.deepEqual(lines, [
    'using [REDACTED] and [REDACTED]',
    'again [REDACTED]',
  ]);

  await transport.close();
});

void test('a stderr line that never ends keeps only its end, with no part of a secret', async () => {
  const fake = fakeProcess();
  const lines: string[] = [];
  const secret = 'S3CRET-T0KEN';
  const transport = createSandboxStdioTransport({
    start: fake.start,
    secrets: [secret],
    onStderr: (line) => {
      lines.push(line);
    },
  });
  await transport.start();
  // Over a million characters, in chunks that split the secret anywhere.
  const stream = `x${secret}`.repeat(100_000);

  for (let index = 0; index < stream.length; index += 4093) {
    fake.emit({ stream: 'stderr', data: stream.slice(index, index + 4093) });
  }
  fake.emit({ stream: 'stderr', data: ' the end' });
  fake.exit(1);

  await eventually(
    () => lines.length === 1,
    'the last stderr line',
    () => lines.length,
  );
  const [line = ''] = lines;

  assert.ok(line.length < 100_000, `${line.length} characters`);

  assert.ok(line.endsWith(' the end'));

  assert.doesNotMatch(line.replaceAll('[REDACTED]', ''), /[S3CRET0KN-]/u);
});
