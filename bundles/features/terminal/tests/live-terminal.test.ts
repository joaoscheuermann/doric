// The live terminal behind a `terminal` call in the chat (bundle isolation
// 5(b), change 4, T-3, S-7): the rules the chat's `stores/live-terminals.ts`
// kept, now pure functions of this bundle over the store's terminal list.
// - The output a call shows keeps its last 32,000 characters.
// - A call finds its terminal by the id its result names; otherwise, only
//   while the call runs, by its Thread and command, the newest active one
//   first.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  appendCapped,
  LIVE_OUTPUT_LIMIT,
  matchLiveTerminal,
} from '../src/client/domain/live-terminal.js';
import type { Terminal } from '../src/client/domain/terminals.js';

const threadId = 'thread-1';

/** An agent's terminal on the Thread, started `second` seconds into the day. */
const terminal = (
  id: string,
  overrides: Partial<Terminal> = {},
  second = 0,
): Terminal => ({
  id,
  projectId: 'project-1',
  threadId,
  origin: 'agent',
  command: 'npm test',
  cwd: '/workspace',
  startedAt: `2026-01-01T00:00:${String(second).padStart(2, '0')}.000Z`,
  timeoutMs: 120_000,
  state: 'running',
  pty: false,
  ...overrides,
});

describe('the output a call shows', () => {
  test('is capped at 32,000 characters', () => {
    assert.equal(LIVE_OUTPUT_LIMIT, 32_000);
  });

  test('appends a chunk while the whole stays under the cap', () => {
    assert.equal(appendCapped('', 'line 1\n'), 'line 1\n');
    assert.equal(appendCapped('line 1\n', 'line 2\n'), 'line 1\nline 2\n');
  });

  test('keeps the last 32,000 characters once the output grows past them', () => {
    const output = appendCapped('a'.repeat(31_990), 'b'.repeat(20));

    assert.equal(output.length, 32_000);
    assert.equal(output, `${'a'.repeat(31_980)}${'b'.repeat(20)}`);
  });

  test('keeps the end of a single chunk longer than the cap', () => {
    const chunk = `${'x'.repeat(10)}${'y'.repeat(32_000)}`;

    assert.equal(appendCapped('earlier', chunk), 'y'.repeat(32_000));
  });
});

describe("the terminal a call's block follows", () => {
  test('is the one its result names, whatever the call, Thread or state', () => {
    const named = terminal('term-2', {
      threadId: 'another-thread',
      command: 'npm run dev',
      state: 'exited',
    });
    const terminals = [terminal('term-1'), named];

    assert.equal(
      matchLiveTerminal(terminals, {
        threadId,
        command: 'npm test',
        terminalId: 'term-2',
        toolRunning: false,
      }),
      named,
    );
    // A named terminal the list does not hold is no terminal at all, even
    // when another one would match the call's command.
    assert.equal(
      matchLiveTerminal(terminals, {
        threadId,
        command: 'npm test',
        terminalId: 'term-9',
        toolRunning: true,
      }),
      undefined,
    );
  });

  test("is found by the call's Thread and command only while the call runs", () => {
    const running = terminal('term-1');

    assert.equal(
      matchLiveTerminal([running], {
        threadId,
        command: 'npm test',
        toolRunning: true,
      }),
      running,
    );
    assert.equal(
      matchLiveTerminal([running], {
        threadId,
        command: 'npm test',
        toolRunning: false,
      }),
      undefined,
    );
  });

  test("is an agent's terminal on the call's Thread running the call's command", () => {
    const terminals = [
      terminal('user-shell', { origin: 'user' }),
      terminal('other-thread', { threadId: 'thread-2' }),
      terminal('other-command', { command: 'npm run lint' }),
    ];

    assert.equal(
      matchLiveTerminal(terminals, {
        threadId,
        command: 'npm test',
        toolRunning: true,
      }),
      undefined,
    );
  });

  test('is the newest active one, over a newer one that exited', () => {
    const older = terminal('term-1', { state: 'running' }, 1);
    const newer = terminal('term-2', { state: 'starting' }, 2);
    const exited = terminal('term-3', { state: 'exited' }, 3);

    assert.equal(
      matchLiveTerminal([older, newer, exited], {
        threadId,
        command: 'npm test',
        toolRunning: true,
      }),
      newer,
    );
  });

  test('is the newest one when every match has exited', () => {
    const first = terminal('term-1', { state: 'exited' }, 1);
    const last = terminal('term-2', { state: 'exited' }, 2);

    assert.equal(
      matchLiveTerminal([first, last], {
        threadId,
        command: 'npm test',
        toolRunning: true,
      }),
      last,
    );
  });
});
