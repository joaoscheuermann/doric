// Another Thread's input in a conversation, as the reader meets it once the
// threads bundle draws it for chat (`chat.delegated-input/v1`): the label,
// the sender, the status and the text, the open state the reader controls,
// and opening the sender's conversation when `runtime.records/v1` holds it.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import type { RuntimeRecords, Thread } from 'runtime/contracts';
import { createRecordsApi } from 'runtime/testing';

import {
  openThreadsWindow,
  settle,
  type ThreadsWindow,
} from './support/window.js';

const projectId = '11111111-1111-4111-8111-111111111111';
const threadId = '22222222-2222-4222-8222-222222222222';
const promptId = '33333333-3333-4333-8333-333333333333';
const senderId = '44444444-4444-4444-8444-444444444444';
const url = `doric://app/projects/${projectId}/threads/${threadId}`;

const thread = {
  id: threadId,
  name: 'Fix the parser',
  projectId,
  state: 'ready',
  lastSequence: 0,
  cwd: '/workspace',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const accepted = (text: string, source: Record<string, unknown>) => ({
  projectId,
  threadId,
  promptId,
  sequence: 1,
  type: 'prompt.accepted',
  event: { type: 'prompt.accepted', text, source },
  createdAt: '2026-01-01T00:00:01.000Z',
});

const instruction = accepted('Fix the parser first.', {
  kind: 'parent',
  threadId: senderId,
});

/** A child result exactly as the host frames it for the model. */
const result = accepted(
  [
    '# Delegated task result',
    '',
    `Child thread: ${senderId}`,
    'Child prompt: 92f6930f-2f1a-4e52-8215-395ab1246193',
    'Originating prompt: 4ac62e86-27dd-4ffe-88f9-f53922ccadf4',
    'Status: completed',
    '',
    '## Result',
    '',
    'The parser is fixed.',
  ].join('\n'),
  { kind: 'result', threadId: senderId },
);

const host = {
  'runtime.threads/v1.thread': () => thread,
  'runtime.threads/v1.queue': () => ({
    revision: 1,
    paused: false,
    stopping: false,
    items: [],
  }),
};

/**
 * `runtime.records/v1` as the window's records, which may learn the sender:
 * the conversation's own Thread is known from the start, the sender once
 * `know` is called, and every change tells the subscribers.
 */
const records = () => {
  let sender: Thread | undefined;
  const listeners = new Set<() => void>();
  const own = thread as unknown as Thread;
  const recordsApi: RuntimeRecords = {
    ...createRecordsApi({ threads: [own] }),
    thread: (id) =>
      id === threadId ? own : id === senderId ? sender : undefined,
    subscribe: (listener) => {
      const heard = () => listener();
      listeners.add(heard);
      return { dispose: () => void listeners.delete(heard) };
    },
  };
  return {
    know(name: string) {
      sender = { ...own, id: senderId, name };
      for (const listener of [...listeners]) listener();
    },
    recordsApi,
  };
};

const deliver = async (window: ThreadsWindow, events: readonly unknown[]) => {
  const watch = window.watches().at(-1);
  assert.notEqual(watch, undefined, 'the conversation watches its Thread');
  watch?.push({
    kind: 'snapshot',
    threadId,
    projectId,
    project: null,
    thread,
    events,
  });
  await settle(150);
};

const turnOf = (window: ThreadsWindow): HTMLElement | null =>
  window.document.querySelector(`[data-prompt-id="${promptId}"]`);

const elementOf = (window: ThreadsWindow) =>
  turnOf(window)?.querySelector('threads-delegated-turn') as
    | (HTMLElement & { toggle(): void; readonly chosen: boolean })
    | null
    | undefined;

const toggles = (window: ThreadsWindow, name: string) =>
  [...(turnOf(window)?.querySelectorAll('button') ?? [])].filter(
    (button) => button.getAttribute('aria-label') === name,
  );

let opened: ThreadsWindow | undefined;

afterEach(async () => {
  await opened?.close();
  opened = undefined;
});

test('a delegated instruction opens on its words, from a sender the records do not hold', async () => {
  opened = await openThreadsWindow({ url, host });
  await settle();
  await deliver(opened, [instruction]);

  const element = elementOf(opened);
  assert.notEqual(element, null, 'threads draws the delegated input');
  assert.match(turnOf(opened)?.textContent ?? '', /Instruction from:/);
  assert.equal(element?.chosen, true);
  assert.equal(
    turnOf(opened)?.querySelector('.editor-paragraph')?.textContent,
    'Fix the parser first.',
  );
  // An unknown sender is its short id, in monospace, with the full id as title.
  const label = turnOf(opened)?.querySelector(`[title="${senderId}"]`);
  assert.equal(label?.textContent, '44444444');
  assert.equal(label?.classList.contains('font-mono'), true);
  assert.equal(label?.tagName, 'SPAN');
  assert.equal(toggles(opened, 'Toggle instruction from 44444444').length, 2);
  assert.doesNotMatch(turnOf(opened)?.textContent ?? '', /Status:/);
});

test('a delegated result starts closed and opens on its status and the child words', async () => {
  opened = await openThreadsWindow({ url, host });
  await settle();
  await deliver(opened, [result]);

  assert.match(turnOf(opened)?.textContent ?? '', /Result from:/);
  assert.equal(elementOf(opened)?.chosen, false);
  assert.doesNotMatch(turnOf(opened)?.textContent ?? '', /The parser is fixed/);

  const [toggle] = toggles(opened, 'Toggle result from 44444444');
  toggle?.click();
  await settle(50);

  assert.equal(elementOf(opened)?.chosen, true);
  const text = turnOf(opened)?.textContent ?? '';
  assert.match(text, /Status: completed/);
  assert.equal(
    turnOf(opened)?.querySelector('.editor-paragraph')?.textContent,
    'The parser is fixed.',
  );
  assert.doesNotMatch(text, /Delegated task result/);
});

test("the conversation's toggle reaches the element, and the reader's choice stands", async () => {
  opened = await openThreadsWindow({ url, host });
  await settle();
  await deliver(opened, [instruction]);

  elementOf(opened)?.toggle();
  await settle(50);
  assert.equal(elementOf(opened)?.chosen, false);
  assert.doesNotMatch(
    turnOf(opened)?.textContent ?? '',
    /Fix the parser first/,
  );

  elementOf(opened)?.toggle();
  await settle(50);
  assert.equal(elementOf(opened)?.chosen, true);
  assert.match(turnOf(opened)?.textContent ?? '', /Fix the parser first/);
});

test('a sender the records hold is named and opens its conversation', async () => {
  const held = records();
  opened = await openThreadsWindow({ url, host, recordsApi: held.recordsApi });
  await settle();
  await deliver(opened, [instruction]);

  assert.equal(
    turnOf(opened)?.querySelector(`[title="${senderId}"]`)?.tagName,
    'SPAN',
  );

  held.know('Parent planner');
  await settle(50);

  const link = turnOf(opened)?.querySelector(`button[title="${senderId}"]`);
  assert.equal(link?.textContent, 'Parent planner');
  assert.equal(
    toggles(opened, 'Toggle instruction from Parent planner').length,
    2,
  );

  (link as HTMLElement | null)?.click();
  await settle(50);
  assert.equal(
    opened.window.location.pathname,
    `/projects/${projectId}/threads/${senderId}`,
  );
});
