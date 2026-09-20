import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import type {
  SandboxExecInput,
  SandboxExecResult,
  SandboxSession,
} from 'sandbox';

import { createTool } from '../tools/terminal.js';

type FakeSandbox = SandboxSession & {
  readonly execs: SandboxExecInput[];
};

describe('terminal tool', () => {
  test('executes a command from the requested sandbox working directory', async () => {
    const sandbox = fakeSandbox(execResult({ stdout: 'hello\n' }));

    const result = await createTool()(sandbox).execute({
      command: "printf 'hello'",
      working_directory: 'repo/src',
      timeout_ms: 5000,
    });

    assert.deepEqual(sandbox.execs, [
      {
        cmd: ['sh', '-lc', "printf 'hello'"],
        cwd: '/workspace/repo/src',
        timeoutMs: 5000,
      },
    ]);

    assert.equal(result.schema, 'terminal.compact.v1');

    assert.equal(result.working_directory, '/workspace/repo/src');

    assert.equal(result.exit_code, 0);

    assert.equal(result.success, true);

    assert.deepEqual(result.stdout.head, ['hello']);
  });

  test('uses the sandbox workspace root by default and caps timeout', async () => {
    const sandbox = fakeSandbox(execResult());

    await createTool()(sandbox).execute({
      command: 'pwd',
      timeout_ms: 999_999,
    });

    assert.deepEqual(sandbox.execs, [
      {
        cmd: ['sh', '-lc', 'pwd'],
        cwd: '/workspace',
        timeoutMs: 600_000,
      },
    ]);
  });

  test('maps a sandbox result without an exit code to -1', async () => {
    const sandbox = fakeSandbox(
      execResult({
        exitCode: null,
        stderr: 'Command timed out after 10ms',
      }),
    );

    const result = await createTool()(sandbox).execute({
      command: 'sleep 1',
      timeout_ms: 10,
    });

    assert.equal(result.exit_code, -1);

    assert.equal(result.success, false);

    assert.match(result.stderr.head.join('\n'), /timed out/u);
  });

  test('returns sandbox execution errors as compact terminal output', async () => {
    const sandbox = fakeSandbox(new Error('container exec failed'));

    const result = await createTool()(sandbox).execute({
      command: 'echo hello',
      timeout_ms: 5000,
    });

    assert.equal(result.exit_code, -1);

    assert.equal(result.success, false);

    assert.match(result.stderr.head.join('\n'), /container exec failed/u);
  });

  test('extracts diagnostics from sandbox stderr', async () => {
    const sandbox = fakeSandbox(
      execResult({
        exitCode: 1,
        stderr: 'src/index.ts(1,2): error TS2304: Cannot find name x',
      }),
    );

    const result = await createTool()(sandbox).execute({
      command: 'npm test',
      timeout_ms: 5000,
    });

    assert.equal(result.success, false);

    assert.equal(result.diagnostics[0]?.kind, 'typescript_error');

    assert.equal(result.diagnostics[0]?.stream, 'stderr');

    assert.match(result.diagnostics[0]?.text ?? '', /TS2304/u);
  });

  test('writes raw output traces on the host when trace storage is enabled', async () => {
    const traceDir = await mkdtemp(path.join(os.tmpdir(), 'doric-terminal-'));
    const sandbox = fakeSandbox(execResult({ stdout: 'hello\n' }));

    try {
      const result = await createTool({ traceDir })(sandbox).execute({
        command: 'echo hello',
      });
      const rawOutputRef = result.raw_output_ref;

      assert.ok(result.trace_id);

      assert.ok(rawOutputRef);

      assert.equal(
        rawOutputRef,
        path.join(traceDir, `${result.trace_id}.json`),
      );

      const trace = JSON.parse(await readFile(rawOutputRef, 'utf8')) as {
        readonly command: string;
        readonly workingDirectory: string;
        readonly stdout: string;
      };

      assert.equal(trace.command, 'echo hello');

      assert.equal(trace.workingDirectory, '/workspace');

      assert.equal(trace.stdout, 'hello\n');
    } finally {
      await rm(traceDir, { recursive: true, force: true });
    }
  });
});

const fakeSandbox = (behavior: SandboxExecResult | Error): FakeSandbox => {
  const execs: SandboxExecInput[] = [];

  return {
    id: 'sandbox-1',
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
    dispose: unsupported,
  };
};

const execResult = ({
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
  throw new Error('not used by terminal tests');
};
