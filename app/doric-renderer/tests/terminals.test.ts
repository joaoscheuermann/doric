import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  type Terminal,
  terminalLabel,
  threadTerminals,
  unseenOutput,
} from '../src/domain/terminals.js';
import { upsert } from '../src/domain/workspace.js';

const terminal: Terminal = {
  id: 'one',
  projectId: 'project',
  threadId: 'thread',
  origin: 'agent',
  command: 'npm run dev',
  cwd: '/workspace',
  startedAt: '2026-10-03T00:00:00Z',
  timeoutMs: 600_000,
  state: 'running',
  pty: true,
};

test('formats the command, elapsed time and timeout in the sidebar', () => {
  assert.equal(
    terminalLabel(terminal, Date.parse('2026-10-03T00:02:30Z')),
    'npm run dev · 02:30 (10 min)',
  );
  assert.equal(
    terminalLabel(
      { ...terminal, timeoutMs: 30_000 },
      Date.parse(terminal.startedAt),
    ),
    'npm run dev · 00:00 (30 sec)',
  );
});

test('manual shell labels contain only the current command', () => {
  assert.equal(
    terminalLabel(
      { ...terminal, origin: 'user' },
      Date.parse('2026-10-03T00:02:30Z'),
    ),
    'npm run dev',
  );
});

test('formats fractional-minute and subsecond timeouts without decimal-minute labels', () => {
  const now = Date.parse(terminal.startedAt);
  assert.equal(
    terminalLabel({ ...terminal, timeoutMs: 90_000 }, now),
    'npm run dev · 00:00 (1 min 30 sec)',
  );
  assert.equal(
    terminalLabel({ ...terminal, timeoutMs: 500 }, now),
    'npm run dev · 00:00 (<1 sec)',
  );
  assert.equal(
    terminalLabel({ ...terminal, timeoutMs: null }, now),
    'npm run dev · 00:00 (no limit)',
  );
});

test('replayed and overlapping output never duplicates already rendered text', () => {
  assert.equal(unseenOutput('hello', 5, 5), '');
  assert.equal(unseenOutput('lo world', 11, 5), ' world');
  assert.equal(unseenOutput('😀', 13, 11), '😀');
});

test('only shows terminals owned by the requested thread', () => {
  assert.deepEqual(
    threadTerminals(
      [terminal, { ...terminal, id: 'two', threadId: 'other' }],
      'thread',
    ).map((item) => item.id),
    ['one'],
  );
});

test('changing a shell command preserves sidebar order while a new terminal appends', () => {
  const manual: Terminal = { ...terminal, origin: 'user', command: 'bash' };
  const other = { ...terminal, id: 'two' };
  const updated = upsert([manual, other], { ...manual, command: 'ls' }, 'last');
  const appended = upsert(updated, { ...terminal, id: 'three' }, 'last');
  assert.deepEqual(
    appended.map((item) => item.id),
    ['one', 'two', 'three'],
  );
  assert.equal(appended[0]?.command, 'ls');
});
