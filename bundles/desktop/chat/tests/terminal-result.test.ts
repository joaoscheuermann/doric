import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  parseTerminalResult,
  type TerminalResult,
  terminalResultEquals,
  terminalResultFailed,
  terminalResultInput,
} from '../src/client/domain/terminal-result.js';

/** The prompt the host writes for a settled background command. */
const envelope = (input: {
  readonly command?: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: string;
  readonly reason?: string;
  readonly duration?: string;
}): string =>
  [
    '# Background terminal result',
    '',
    'Terminal: terminal-3f8a',
    'Originating prompt: a0000000-0000-4000-8000-000000003099',
    `Command: ${input.command ?? 'npm test -- --run src/checkout'}`,
    `Exit code: ${input.exitCode ?? '0'}`,
    `Reason: ${input.reason ?? 'exited'}`,
    `Duration: ${input.duration ?? '2340'} ms`,
    '',
    '## Standard output (last 12000 characters)',
    '',
    input.stdout ?? ' RUN  v2.1.4 /workspace/storefront\n 2 passed (2)',
    '',
    '## Standard error (last 12000 characters)',
    '',
    input.stderr ?? '',
  ].join('\n');

/** The reading of an envelope the host wrote, which every test here expects. */
const parsed = (input: Parameters<typeof envelope>[0] = {}): TerminalResult => {
  const result = parseTerminalResult(envelope(input));
  assert.ok(result !== undefined, 'the envelope should read');
  return result;
};

describe('a background terminal result', () => {
  test('reads the command, the outcome and both streams', () => {
    assert.deepEqual(parsed({ stderr: 'warning: 1' }), {
      terminalId: 'terminal-3f8a',
      promptId: 'a0000000-0000-4000-8000-000000003099',
      command: 'npm test -- --run src/checkout',
      exitCode: 0,
      reason: 'exited',
      durationMs: 2_340,
      stdout: ' RUN  v2.1.4 /workspace/storefront\n 2 passed (2)',
      stderr: 'warning: 1',
    });
  });

  test('keeps a stream that reported nothing as empty', () => {
    const result = parsed({ stdout: '' });

    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  });

  test('keeps the blank lines inside a stream', () => {
    assert.equal(parsed({ stdout: 'one\n\ntwo\n\n' }).stdout, 'one\n\ntwo');
  });

  test('reads a command the shell wrapped over lines whole', () => {
    const result = parsed({ command: 'set -e\nnpm run build' });

    assert.equal(result.command, 'set -e\nnpm run build');
    assert.equal(result.exitCode, 0);
  });

  test('leaves text that is not the host envelope unread', () => {
    assert.equal(parseTerminalResult('npm test failed'), undefined);
    assert.equal(
      parseTerminalResult('# Delegated task result\n\n## Result'),
      undefined,
    );
  });

  test('leaves an envelope it cannot read whole unread', () => {
    assert.equal(
      parseTerminalResult(envelope({}).replace('Reason: exited\n', '')),
      undefined,
    );
    assert.equal(
      parseTerminalResult(envelope({ reason: 'cancelled' })),
      undefined,
    );
    assert.equal(
      parseTerminalResult(envelope({ exitCode: 'zero' })),
      undefined,
    );
    assert.equal(
      parseTerminalResult(envelope({ duration: 'soon' })),
      undefined,
    );
  });

  test('reads only a prompt a terminal sourced', () => {
    const text = envelope({});

    assert.notEqual(
      terminalResultInput(
        { kind: 'terminal', terminalId: 'terminal-3f8a' },
        text,
      ),
      undefined,
    );
    assert.equal(terminalResultInput({ kind: 'user' }, text), undefined);
    assert.equal(
      terminalResultInput({ kind: 'result', threadId: 'x' }, text),
      undefined,
    );
    assert.equal(terminalResultInput(undefined, text), undefined);
  });

  test('counts a non-zero exit and a stopped command as failures', () => {
    assert.equal(terminalResultFailed(parsed()), false);
    assert.equal(terminalResultFailed(parsed({ exitCode: '1' })), true);
    assert.equal(
      terminalResultFailed(parsed({ exitCode: '-1', reason: 'timeout' })),
      true,
    );
  });

  test('compares two readings of one result by what they say', () => {
    assert.equal(terminalResultEquals(parsed(), parsed()), true);
    assert.equal(
      terminalResultEquals(parsed(), parsed({ stdout: 'again' })),
      false,
    );
  });
});
