import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  agentControl,
  lastPromptFailed,
  lastReaderText,
  standingPause,
} from '../src/client/domain/agent-control.js';
import type { Turn } from '../src/client/domain/projector.js';
import type { ThreadQueue } from '../src/client/domain/queue.js';
import type { Thread } from '../src/client/domain/workspace.js';

const thread = (overrides: Partial<Thread> = {}): Thread => ({
  id: '11111111-1111-4111-8111-111111111111',
  projectId: '22222222-2222-4222-8222-222222222222',
  name: 'Investigate the failing build',
  parentThreadId: '33333333-3333-4333-8333-333333333333',
  origin: 'agent',
  state: 'ready',
  cwd: '/workspace',
  createdAt: '',
  updatedAt: '',
  ...overrides,
});

const queueOf = (paused: boolean): ThreadQueue => ({
  revision: 0,
  paused,
  stopping: false,
  items: [],
});

const user = (text: string, promptId = 'p1'): Turn => ({
  type: 'user',
  promptId,
  events: [],
  text,
  accepted: true,
  comments: [],
  awaiting: false,
});

const agent = (
  status: 'queued' | 'streaming' | 'completed' | 'failed' | 'cancelled',
  promptId = 'p1',
): Turn => ({ type: 'agent', promptId, events: [], text: '', status });

const pause = (standing: boolean, promptId = 'p1'): Turn => ({
  type: 'lifecycle',
  promptId,
  events: [],
  lifecycle: { kind: 'pause', reason: 'reader_stopped', at: '', standing },
});

const resumed = (promptId = 'p1'): Turn => ({
  type: 'lifecycle',
  promptId,
  events: [],
  lifecycle: { kind: 'resume', attempt: 2 },
});

const failure = (promptId = 'p1'): Turn => ({
  type: 'failure',
  promptId,
  events: [],
  failure: { name: 'AgentError', code: 'tool_failed', message: '' },
});

describe('lastReaderText', () => {
  test('answers the newest words the reader wrote', () => {
    assert.equal(
      lastReaderText([user('first', 'p1'), user('second', 'p2')]),
      'second',
    );
  });

  test('skips an input another Thread wrote, which has no words', () => {
    assert.equal(
      lastReaderText([user('first', 'p1'), user('   ', 'p2')]),
      'first',
    );
  });

  test('answers nothing for a conversation the reader has not written in', () => {
    assert.equal(lastReaderText([agent('completed')]), undefined);
  });
});

describe('standingPause', () => {
  test('names the prompt of a pause nothing has taken up', () => {
    assert.deepEqual(standingPause([user('go'), pause(true)]), {
      promptId: 'p1',
    });
  });

  test('a resume ends the pause it took up', () => {
    assert.equal(
      standingPause([user('go'), pause(true), resumed()]),
      undefined,
    );
  });

  test('a pause a prompt finished after no longer stands', () => {
    assert.equal(
      standingPause([user('go'), pause(false), agent('completed')]),
      undefined,
    );
  });
});

describe('lastPromptFailed', () => {
  test('a failure closes the newest prompt as failed', () => {
    assert.equal(lastPromptFailed([user('go'), failure()]), true);
  });

  test('an agent turn that failed is a failure too', () => {
    assert.equal(lastPromptFailed([user('go'), agent('failed')]), true);
  });

  test('the newest prompt decides, not an older one', () => {
    assert.equal(
      lastPromptFailed([
        user('go', 'p1'),
        failure('p1'),
        user('again', 'p2'),
        agent('completed', 'p2'),
      ]),
      false,
    );
  });
});

describe('agentControl', () => {
  test('a running agent Thread offers Pause alone', () => {
    const control = agentControl(
      thread({ state: 'running', activePromptId: 'p1' }),
      [user('go'), { ...agent('streaming'), promptId: 'p1' }],
      undefined,
    );

    assert.equal(control.status, 'running');
    assert.equal(control.canPause, true);
    assert.equal(control.canContinue, false);
    assert.equal(control.canRetry, false);
  });

  test('a pause the reader made offers Continue, not Retry', () => {
    const control = agentControl(
      thread(),
      [user('go'), pause(true)],
      queueOf(false),
    );

    assert.equal(control.status, 'paused');
    assert.equal(control.canPause, false);
    assert.equal(control.canContinue, true);
    assert.equal(control.pausedPromptId, 'p1');
    assert.equal(control.canRetry, false);
  });

  test('a held queue counts as paused even without a pause row', () => {
    const control = agentControl(
      thread(),
      [user('go'), agent('streaming')],
      queueOf(true),
    );

    assert.equal(control.status, 'paused');
    assert.equal(control.canContinue, true);
  });

  test('a failed agent Thread offers Retry with the last words', () => {
    const control = agentControl(
      thread(),
      [user('go'), failure()],
      queueOf(false),
    );

    assert.equal(control.status, 'failed');
    assert.equal(control.canPause, false);
    assert.equal(control.canContinue, false);
    assert.equal(control.canRetry, true);
    assert.equal(control.retryText, 'go');
  });

  test('a finished agent Thread still offers Retry', () => {
    const control = agentControl(
      thread(),
      [user('go'), agent('completed')],
      queueOf(false),
    );

    assert.equal(control.status, 'idle');
    assert.equal(control.canRetry, true);
  });

  test('a conversation with nothing to send offers nothing', () => {
    const control = agentControl(thread(), [], undefined);

    assert.deepEqual(control, {
      status: 'idle',
      canPause: false,
      canContinue: false,
      canRetry: false,
    });
  });
});
