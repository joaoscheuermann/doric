import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import type { StreamListener } from 'bundle/contracts';

import type {
  ChatTerminalsApi,
  Terminal,
  TerminalWatchItem,
} from '../src/client/api/terminals-contract.js';
import {
  matchLiveTerminal,
  resetLiveTerminalsStore,
  retainProjectTerminals,
  setTerminalServiceApi,
  stopLiveTerminal,
  unseenTerminalOutput,
} from '../src/client/stores/live-terminals.js';

const sampleTerminal = (overrides: Partial<Terminal> = {}): Terminal => ({
  id: 'term-1',
  projectId: 'proj-1',
  threadId: 'thread-1',
  origin: 'agent',
  command: 'npm test',
  cwd: '/workspace',
  startedAt: '2026-01-01T00:00:00.000Z',
  timeoutMs: 120_000,
  state: 'running',
  pty: false,
  ...overrides,
});

afterEach(() => {
  resetLiveTerminalsStore();
});

describe('live terminals store', () => {
  test('reconciles overlapping and fresh UTF-16 output chunks by offset', () => {
    assert.equal(unseenTerminalOutput('hello', 5, 0), 'hello');
    assert.equal(unseenTerminalOutput('hello', 5, 5), '');
    assert.equal(unseenTerminalOutput('hello world', 11, 5), ' world');
  });

  test('streams live output for a running agent command and stops the session on request', () => {
    let streamListener: StreamListener<TerminalWatchItem> | undefined;
    const stoppedIds: string[] = [];
    const emit = (item: TerminalWatchItem): void => {
      if (typeof streamListener === 'function') {
        streamListener(item);
      } else {
        streamListener?.next(item);
      }
    };

    const api: ChatTerminalsApi = {
      snapshot: async () => undefined,
      stop: async (id) => {
        stoppedIds.push(id);
        return true;
      },
      watchProject: (_projectId, listener) => {
        streamListener = listener;
        return { dispose: () => {} };
      },
    };

    setTerminalServiceApi(api);
    const release = retainProjectTerminals('proj-1');
    assert.ok(streamListener);

    emit({
      kind: 'snapshot',
      projectId: 'proj-1',
      terminals: [sampleTerminal()],
    });

    emit({
      kind: 'output',
      output: {
        projectId: 'proj-1',
        threadId: 'thread-1',
        terminalId: 'term-1',
        data: 'line 1\n',
        offset: 7,
      },
    });
    emit({
      kind: 'output',
      output: {
        projectId: 'proj-1',
        threadId: 'thread-1',
        terminalId: 'term-1',
        data: 'line 2\n',
        offset: 14,
      },
    });

    const matched = matchLiveTerminal({
      threadId: 'thread-1',
      command: 'npm test',
      terminalId: undefined,
      toolRunning: true,
    });
    assert.ok(matched);
    assert.equal(matched.terminal.id, 'term-1');
    assert.equal(matched.terminal.state, 'running');
    assert.equal(matched.output, 'line 1\nline 2\n');

    stopLiveTerminal('term-1');
    assert.deepEqual(stoppedIds, ['term-1']);

    const afterStop = matchLiveTerminal({
      threadId: 'thread-1',
      command: 'npm test',
      terminalId: undefined,
      toolRunning: true,
    });
    assert.equal(afterStop?.terminal.state, 'exited');
    assert.equal(afterStop?.output, 'line 1\nline 2\n');

    release();
  });
});
