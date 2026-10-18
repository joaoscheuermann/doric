import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  formatCommandPreview,
  formatDuration,
  parseTerminalCall,
  wholeStream,
} from '../src/client/domain/terminal-tool.js';

describe('terminal tool domain parsing', () => {
  test('parses a running terminal call from its input args', () => {
    const parsed = parseTerminalCall(
      JSON.stringify({
        command: 'npm test',
        working_directory: '/workspace/doric',
      }),
    );

    assert.equal(parsed.command, 'npm test');
    assert.equal(parsed.workingDirectory, '/workspace/doric');
    assert.equal(parsed.stdout, undefined);
  });

  test('parses a completed terminal.compact.v1 output record', () => {
    const parsed = parseTerminalCall(
      JSON.stringify({ command: 'cargo test' }),
      JSON.stringify({
        schema: 'terminal.compact.v1',
        trace_id: null,
        command: 'cargo test',
        working_directory: '/workspace/app',
        exit_code: 1,
        duration_ms: 1450,
        termination_reason: 'exited',
        success: false,
        stdout: {
          bytes: 120,
          lines: 10,
          head: ['running 2 tests', 'test a ... ok'],
          tail: ['test b ... FAILED'],
          omitted_lines: 7,
          omitted_bytes: 80,
          truncated: true,
        },
        stderr: {
          bytes: 22,
          lines: 1,
          head: ['error: test failed'],
          tail: [],
          omitted_lines: 0,
          omitted_bytes: 0,
          truncated: false,
        },
        diagnostics: [],
        truncation: { truncated: true, message: 'compacted' },
        raw_output_ref: null,
      }),
    );

    assert.equal(parsed.command, 'cargo test');
    assert.equal(parsed.workingDirectory, '/workspace/app');
    assert.equal(parsed.exitCode, 1);
    assert.equal(parsed.durationMs, 1450);
    assert.equal(parsed.terminationReason, 'exited');
    assert.equal(parsed.success, false);
    assert.deepEqual(parsed.stdout?.head, ['running 2 tests', 'test a ... ok']);
    assert.deepEqual(parsed.stdout?.tail, ['test b ... FAILED']);
    assert.equal(parsed.stdout?.omittedLines, 7);
    assert.deepEqual(parsed.stderr?.head, ['error: test failed']);
    assert.equal(parsed.truncationMessage, 'compacted');
  });

  test('parses a background terminal output record', () => {
    const parsed = parseTerminalCall(
      JSON.stringify({ command: 'npm run dev', background: true }),
      JSON.stringify({ terminal_id: 'term-42', background: true }),
    );

    assert.equal(parsed.command, 'npm run dev');
    assert.equal(parsed.background, true);
    assert.equal(parsed.terminalId, 'term-42');
  });

  test('falls back to rawOutput when result is plain text', () => {
    const parsed = parseTerminalCall(
      JSON.stringify({ command: 'pwd' }),
      '/workspace',
    );

    assert.equal(parsed.command, 'pwd');
    assert.equal(parsed.rawOutput, '/workspace');
  });

  test('formats command previews and durations cleanly', () => {
    assert.equal(
      formatCommandPreview('echo   hello\n  world'),
      'echo hello world',
    );
    assert.equal(formatCommandPreview('abcdef', 4), 'abc…');
    assert.equal(formatDuration(420), '420ms');
    assert.equal(formatDuration(1500), '1.5s');
    assert.equal(formatDuration(2000), '2s');
    assert.equal(formatDuration(65_000), '1m 5s');
  });

  test('reads a whole output text as one stream that keeps every line', () => {
    const stream = wholeStream(
      'Test Files  2 passed (2)\nTests  12 passed (12)\n',
    );

    assert.deepEqual(stream?.head, [
      'Test Files  2 passed (2)',
      'Tests  12 passed (12)',
    ]);
    assert.equal(stream?.lines, 2);
    assert.equal(stream?.tail.length, 0);
    assert.equal(stream?.omittedLines, 0);
    // A text with no lines left is no stream at all, so the card draws nothing.
    assert.equal(wholeStream('\n\n'), undefined);
  });
});
