import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { describe, test } from 'node:test';

import type { Sandbox, SandboxExecInput, SandboxExecResult } from 'sandbox';

import { createTool } from '../tools/git.js';

type FakeSandbox = Sandbox & {
  readonly execs: SandboxExecInput[];
};

describe('git tool', () => {
  test('executes structured Git arguments without a shell', async () => {
    const sandbox = fakeSandbox(result({ stdout: 'main\n' }));

    const output = await createTool()(sandbox).execute({
      args: ['branch', '--show-current'],
      working_directory: 'repo',
      timeout_ms: 5000,
    });

    assert.deepEqual(sandbox.execs, [
      {
        cmd: ['git', 'branch', '--show-current'],
        cwd: '/workspace/repo',
        env: [
          'GIT_TERMINAL_PROMPT=0',
          'GIT_EDITOR=true',
          'GIT_SEQUENCE_EDITOR=true',
          'GCM_INTERACTIVE=Never',
        ],
        timeoutMs: 5000,
      },
    ]);

    assert.equal(output.schema, 'git.command.v1');

    assert.equal(output.success, true);

    assert.equal(output.exit_code, 0);

    assert.equal(output.stdout.text, 'main\n');

    assert.equal(output.working_directory, '/workspace/repo');
  });

  test('uses the workspace root by default and caps the timeout', async () => {
    const sandbox = fakeSandbox(result());

    await createTool()(sandbox).execute({
      args: ['status', '--short'],
      timeout_ms: 999_999,
    });

    assert.equal(sandbox.execs[0]?.cwd, '/workspace');

    assert.equal(sandbox.execs[0]?.timeoutMs, 600_000);
  });

  test('returns execution errors as observable Git failures', async () => {
    const output = await createTool()(
      fakeSandbox(new Error('exec failed')),
    ).execute({ args: ['status'] });

    assert.equal(output.success, false);

    assert.equal(output.exit_code, -1);

    assert.match(output.stderr.text, /exec failed/u);
  });

  test('bounds large stdout while preserving its beginning and end', async () => {
    const stdout = `${'a'.repeat(20_000)}${'z'.repeat(20_000)}`;

    const output = await createTool()(fakeSandbox(result({ stdout }))).execute({
      args: ['log', '--oneline', '--all'],
    });

    assert.equal(output.stdout.truncated, true);

    assert.ok(output.stdout.omitted_bytes > 0);

    assert.match(output.stdout.text, /^a+/u);

    assert.match(output.stdout.text, /z+$/u);
  });
});

const fakeSandbox = (behavior: SandboxExecResult | Error): FakeSandbox => {
  const execs: SandboxExecInput[] = [];

  return {
    id: 'git-test',
    root: '/workspace',
    execs,
    async exec(input) {
      execs.push(input);

      if (behavior instanceof Error) {
        throw behavior;
      }

      return behavior;
    },
    cloneRepo: unsupported,
    readFile: unsupported,
    writeFile: unsupported,
    putFile: unsupported,
    getFile: unsupported,
    diff: unsupported,
    ssh: async () => undefined,
  };
};

const result = ({
  exitCode = 0,
  stdout = '',
  stderr = '',
}: {
  readonly exitCode?: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
} = {}): SandboxExecResult => ({
  exitCode,
  stdout,
  stderr,
  stdoutBytes: Buffer.from(stdout),
  stderrBytes: Buffer.from(stderr),
});

const unsupported = (): never => {
  throw new Error('not used by git tool tests');
};
