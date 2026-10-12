import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import { defineMethod, defineService } from 'bundle/contracts';
import { createTestServices } from 'bundle/testing';
import { z } from 'zod';

import type {
  Terminal,
  TerminalInput,
  TerminalResult,
} from '../src/contracts/index.js';
import { createTool, type TerminalOutput } from '../src/host/tool.js';

/*
 * The `terminal` tool (moved from the `files` bundle): the working
 * directory, timeout, compaction, diagnostics and trace rules, over a
 * recording terminal/v1. Every command goes through terminal/v1; the
 * plain-command fallback is gone (D10-12).
 */

const finished = (overrides: Partial<TerminalResult> = {}): TerminalResult => ({
  terminalId: 'terminal-1',
  stdout: '',
  stderr: '',
  exitCode: 0,
  durationMs: 42,
  reason: 'exited',
  ...overrides,
});

const bound = (
  answer: (input: TerminalInput) => ReturnType<Terminal['run']>,
  options: { readonly cwd?: string; readonly traceDir?: string } = {},
) => {
  const runs: TerminalInput[] = [];
  const terminal: Terminal = {
    run: async (input) => {
      runs.push(input);
      return answer(input);
    },
  };
  const harness = createTestServices({
    bundle: { id: 'terminal' },
    provide: [
      defineService('runtime.workspace/v1', {
        cwd: defineMethod({
          input: z.tuple([]),
          output: z.string(),
          execute: async () => options.cwd ?? '/workspace',
        }),
      }),
    ],
  });
  const tool = createTool({
    ...(options.traceDir === undefined ? {} : { traceDir: options.traceDir }),
    terminals: () => terminal,
  })
    .bind(harness.services)
    .toTool(harness.call({ projectId: 'p', threadId: 't', promptId: 'q' }));
  return { tool, runs };
};

const compactOf = (value: unknown): TerminalOutput => {
  assert.ok(typeof value === 'object' && value !== null && 'schema' in value);
  return value as TerminalOutput;
};

void describe('terminal tool', () => {
  void test('returns a terminal reference immediately for a background command', async () => {
    const { tool, runs } = bound(async () => ({
      terminalId: 'terminal-1',
      background: true,
    }));
    assert.deepEqual(
      await tool.execute({
        command: 'npm run dev',
        background: true,
        pty: true,
      }),
      { terminal_id: 'terminal-1', background: true },
    );
    assert.deepEqual(runs, [
      {
        command: 'npm run dev',
        cwd: '/workspace',
        timeoutMs: 120_000,
        background: true,
        pty: true,
      },
    ]);
  });

  void test('resolves the working directory against the Thread cwd and caps the timeout', async () => {
    const { tool, runs } = bound(async () => finished(), {
      cwd: '/workspace/repo/src',
    });
    const byDefault = compactOf(await tool.execute({ command: 'pwd' }));
    await tool.execute({ command: 'ls', working_directory: 'lib' });
    await tool.execute({
      command: 'ls',
      working_directory: '/workspace/other',
      timeout_ms: 999_999,
    });
    await tool.execute({ command: 'ls', working_directory: '  ' });
    assert.deepEqual(
      runs.map(({ cwd, timeoutMs }) => [cwd, timeoutMs]),
      [
        ['/workspace/repo/src', 120_000],
        ['/workspace/repo/src/lib', 120_000],
        ['/workspace/other', 600_000],
        ['/workspace/repo/src', 120_000],
      ],
    );
    assert.equal(byDefault.working_directory, '/workspace/repo/src');
  });

  void test('compacts a foreground result with its termination reason', async () => {
    const { tool } = bound(async () =>
      finished({ stdout: 'hello\n', durationMs: 7 }),
    );
    const result = compactOf(await tool.execute({ command: 'echo hello' }));
    assert.equal(result.schema, 'terminal.compact.v1');
    assert.equal(result.command, 'echo hello');
    assert.deepEqual(result.stdout.head, ['hello']);
    assert.equal(result.duration_ms, 7);
    assert.equal(result.termination_reason, 'exited');
    assert.equal(result.success, true);
    assert.equal(result.trace_id, null);
    assert.equal(result.raw_output_ref, null);
    assert.deepEqual(result.truncation, {
      truncated: false,
      message: 'terminal output fits in compact payload',
    });
  });

  void test('a timed-out command is not a success even with exit code 0', async () => {
    const { tool } = bound(async () =>
      finished({ reason: 'timeout', stderr: 'Terminal timeout exceeded.' }),
    );
    const result = compactOf(await tool.execute({ command: 'sleep 9' }));
    assert.equal(result.success, false);
    assert.equal(result.termination_reason, 'timeout');
    assert.deepEqual(result.stderr.head, ['Terminal timeout exceeded.']);
  });

  void test('extracts diagnostics from stderr', async () => {
    const { tool } = bound(async () =>
      finished({
        exitCode: 1,
        stderr: 'src/index.ts(1,2): error TS2304: Cannot find name x',
      }),
    );
    const result = compactOf(await tool.execute({ command: 'npm test' }));
    assert.equal(result.success, false);
    assert.equal(result.diagnostics[0]?.kind, 'typescript_error');
    assert.equal(result.diagnostics[0]?.stream, 'stderr');
    assert.match(result.diagnostics[0]?.text ?? '', /TS2304/u);
  });

  void test('compacts long output to its head and tail', async () => {
    const lines = Array.from({ length: 2000 }, (_, index) => `line ${index}`);
    const { tool } = bound(async () =>
      finished({ stdout: `${lines.join('\n')}\n` }),
    );
    const result = compactOf(await tool.execute({ command: 'seq' }));
    assert.equal(result.stdout.truncated, true);
    assert.equal(result.stdout.head.length, 24);
    assert.equal(result.stdout.tail.length, 48);
    assert.equal(result.stdout.tail.at(-1), 'line 1999');
    assert.equal(result.stdout.omitted_lines, 2000 - 24 - 48);
    assert.equal(
      result.truncation.message,
      'terminal output compacted; full raw output is available at raw_output_ref',
    );
  });

  void test('writes raw output traces on the host when trace storage is enabled', async () => {
    const traceDir = await mkdtemp(path.join(os.tmpdir(), 'doric-terminal-'));
    try {
      const { tool } = bound(async () => finished({ stdout: 'hello\n' }), {
        traceDir,
      });
      const result = compactOf(await tool.execute({ command: 'echo hello' }));
      assert.ok(result.trace_id);
      assert.equal(
        result.raw_output_ref,
        path.join(traceDir, `${result.trace_id}.json`),
      );
      const trace = JSON.parse(
        await readFile(result.raw_output_ref ?? '', 'utf8'),
      ) as {
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

  void test('a terminal/v1 failure reaches the agent loop as the tool error', async () => {
    const { tool } = bound(async () => {
      throw new Error('Thread is inactive.');
    });
    await assert.rejects(
      tool.execute({ command: 'ls' }),
      /Thread is inactive\./u,
    );
  });
});
