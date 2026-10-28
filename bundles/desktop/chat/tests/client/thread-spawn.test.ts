// A `thread-spawn` call as the reader meets it in a window: a block that says
// the agent handed a task to a Thread of its own — open and spawning while the
// call runs, folded once the child exists and naming it in the header, open with
// its error when the call failed — instead of the generic `Called thread spawn`
// row every other tool draws, and updated in place as the call settles.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import {
  type ClientContext,
  defineMethod,
  defineService,
  ref,
} from 'bundle/contracts';
import { z } from 'zod';

import {
  type ChatWindow,
  openChatWindow,
  type Probe,
  settle,
} from './support/window.js';

const projectId = '11111111-1111-4111-8111-111111111111';
const threadId = '22222222-2222-4222-8222-222222222222';
const promptId = '33333333-3333-4333-8333-333333333333';
const url = `doric://app/projects/${projectId}/threads/${threadId}`;

/** The child the spawn starts, as the workspace knows it. */
const childId = '44444444-4444-4444-8444-444444444444';
const childPromptId = '55555555-5555-4555-8555-555555555555';

const thread = (overrides: Record<string, unknown> = {}) => ({
  id: threadId,
  name: 'Fix the parser',
  projectId,
  state: 'idle',
  cwd: '/workspace',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const records = [
  thread(),
  thread({
    id: childId,
    name: 'Accent audit',
    parentThreadId: threadId,
  }),
];

const event = (
  sequence: number,
  value: Readonly<Record<string, unknown> & { readonly type: string }>,
) => ({
  projectId,
  threadId,
  promptId,
  sequence,
  type: value.type,
  event: value,
  createdAt: `2026-01-01T00:00:0${sequence}.000Z`,
});

const spawnCall = {
  id: 'call-1',
  name: 'thread-spawn',
  payload: { prompt: 'Audit the contrast' },
};

/** The reader asks the agent for something, and it hands part of it down. */
const asked = event(1, {
  type: 'prompt.accepted',
  text: 'Delegate the contrast audit',
  source: { kind: 'user' },
});
const spawning = event(2, { type: 'tool.started', call: spawnCall });
const spawned = event(3, {
  type: 'tool.finished',
  call: spawnCall,
  record: {
    output: JSON.stringify({ threadId: childId, promptId: childPromptId }),
  },
});
const failed = event(3, {
  type: 'tool.failed',
  call: spawnCall,
  error: { message: 'The child Thread could not be started.' },
});

const emptyQueue = { revision: 1, paused: false, stopping: false, items: [] };

const host = (record: unknown) => ({
  'runtime.threads/v1.thread': () => record,
  'runtime.threads/v1.queue': () => emptyQueue,
});

/** A probe standing in for the layout's `layout.workspace/v1` tree. */
const workspaceProbe = (): Probe => ({
  provides: ['layout.workspace/v1'],
  activate: ({ services }: ClientContext) => {
    const LayoutWorkspaceV1 = ref<{
      thread(id: string): unknown;
      selectedThread(): unknown;
      subscribe(listener: () => void): { dispose(): void };
    }>('layout.workspace/v1');
    services.provide(
      defineService(LayoutWorkspaceV1, {
        thread: defineMethod({
          input: z.string(),
          output: z.unknown(),
          execute: (id: string) => records.find((entry) => entry.id === id),
        }),
        selectedThread: defineMethod({
          input: z.tuple([]),
          output: z.unknown(),
          execute: () => records[0],
        }),
        subscribe: defineMethod({
          input: z.custom<() => void>((value) => typeof value === 'function'),
          output: z.custom<{ dispose(): void }>(),
          execute: () => ({ dispose: () => undefined }),
        }),
      }) as never,
    );
  },
});

let opened: ChatWindow | undefined;

afterEach(async () => {
  await opened?.close();
  opened = undefined;
});

/** Opens the Thread and delivers `events` as its log. */
const deliver = async (
  window: ChatWindow,
  events: readonly unknown[],
): Promise<void> => {
  const watch = window.watches().at(-1);
  assert.equal(
    watch !== undefined,
    true,
    'the conversation watches its Thread',
  );
  watch?.push({
    kind: 'snapshot',
    threadId,
    projectId,
    project: null,
    thread: thread(),
    events,
  });
  await settle(150);
};

const open = async (): Promise<ChatWindow> => {
  opened = await openChatWindow({
    url,
    host: host(thread()),
    probe: workspaceProbe(),
  });
  return opened;
};

/** The spawn block the transcript draws for `call-1`. */
const block = (window: ChatWindow): HTMLElement | null =>
  window.document.querySelector('[data-spawn-call-id="call-1"]');

/** The header's own toggle, which opens and closes the block. */
const toggle = (spawn: HTMLElement | null): HTMLElement | null =>
  spawn?.querySelector<HTMLElement>('[data-slot="collapsible-trigger"]') ??
  null;

const viewText = (window: ChatWindow): string =>
  window.document.querySelector('chat-view')?.textContent ?? '';

test('a spawning call draws its own block, open, saying it is spawning', async () => {
  const window = await open();
  await deliver(window, [asked, spawning]);

  const spawn = block(window);
  assert.notEqual(spawn, null);
  assert.match(spawn?.textContent ?? '', /Spawning/);
  // Open: the prompt the agent handed down is readable while the call runs.
  assert.match(spawn?.textContent ?? '', /Audit the contrast/);
  // No child exists yet, so the header names no Thread to open.
  assert.equal(spawn?.querySelector('button[title]'), null);
  // The generic tool row's wording stands nowhere in the transcript.
  assert.doesNotMatch(viewText(window), /Called thread spawn/);
  assert.doesNotMatch(viewText(window), /Calling thread spawn/);
});

test('a finished spawn folds away, naming the Thread it started in its header', async () => {
  const window = await open();
  await deliver(window, [asked, spawning, spawned]);

  const spawn = block(window);
  assert.notEqual(spawn, null);
  assert.match(spawn?.textContent ?? '', /Spawned/);
  // Folded: the prompt is the block's detail, and it is not drawn.
  assert.doesNotMatch(spawn?.textContent ?? '', /Audit the contrast/);

  const link = spawn?.querySelector(`button[title="${childId}"]`) ?? null;
  assert.notEqual(link, null);
  assert.match(link?.textContent ?? '', /Accent audit/);
  // The child's name is part of the header line, not of the folded detail.
  assert.equal(link?.closest('[data-slot="collapsible-content"]'), null);
});

test('a spawn that failed is open with its error and names no Thread', async () => {
  const window = await open();
  await deliver(window, [asked, spawning, failed]);

  const spawn = block(window);
  assert.notEqual(spawn, null);
  assert.match(spawn?.textContent ?? '', /failed/i);
  assert.match(
    spawn?.textContent ?? '',
    /The child Thread could not be started\./,
  );
  // Open: the prompt it was to hand down stays readable beside the error.
  assert.match(spawn?.textContent ?? '', /Audit the contrast/);
  assert.equal(spawn?.querySelector('button[title]'), null);
});

test('a spawning block updates in place once its child exists', async () => {
  const window = await open();
  const events = [asked, spawning];
  await deliver(window, events);

  const before = block(window);
  assert.notEqual(before, null);

  await deliver(window, [...events, spawned]);

  // The sync writes the settled call into the block it already drew, so the
  // reader's caret and their scroll stay where they were.
  assert.equal(block(window), before);
  assert.equal(before?.isConnected, true);
  assert.match(block(window)?.textContent ?? '', /Spawned/);
});

test('a spawn block the reader opened stays open while the transcript goes on', async () => {
  const window = await open();
  const events = [asked, spawning, spawned];
  await deliver(window, events);

  const spawn = block(window);
  assert.notEqual(spawn, null);
  assert.doesNotMatch(spawn?.textContent ?? '', /Audit the contrast/);

  // The reader opens the block a settled spawn folds away on its own.
  toggle(spawn)?.click();
  await settle(100);
  assert.match(spawn?.textContent ?? '', /Audit the contrast/);

  await deliver(window, [
    ...events,
    event(4, { type: 'text.delta', delta: 'Still working on it.' }),
  ]);

  // Their choice is theirs: the run going on must not fold the block again.
  assert.match(block(window)?.textContent ?? '', /Audit the contrast/);
});

/** A spawn call that names how its child runs, beside the prompt. */
const configuredCall = (configuration: Record<string, string>) => ({
  id: 'call-1',
  name: 'thread-spawn',
  payload: { prompt: 'Audit the contrast', ...configuration },
});

/** The header's note of the agent, model and effort the child runs with. */
const meta = (spawn: HTMLElement | null): HTMLElement | null =>
  spawn?.querySelector<HTMLElement>('[data-slot="spawn-meta"]') ?? null;

test('a finished spawn names the agent, model and effort of its child in the header', async () => {
  const call = configuredCall({
    agent: 'reviewer',
    model: 'gpt-5',
    effort: 'high',
  });
  const window = await open();
  await deliver(window, [
    asked,
    event(2, { type: 'tool.started', call }),
    event(3, {
      type: 'tool.finished',
      call,
      record: {
        output: JSON.stringify({ threadId: childId, promptId: childPromptId }),
      },
    }),
  ]);

  const spawn = block(window);
  assert.notEqual(spawn, null);
  assert.equal(toggle(spawn)?.textContent, 'Spawned · reviewer · gpt-5 · high');
  assert.equal(meta(spawn)?.textContent, '· reviewer · gpt-5 · high');
  // The note is part of the header line, not of the folded detail.
  assert.equal(meta(spawn)?.closest('[data-slot="collapsible-content"]'), null);

  // The header still names the child it started.
  const link = spawn?.querySelector(`button[title="${childId}"]`) ?? null;
  assert.notEqual(link, null);
  assert.match(link?.textContent ?? '', /Accent audit/);
  // Folded as before: the prompt is the detail, and it is not drawn.
  assert.doesNotMatch(spawn?.textContent ?? '', /Audit the contrast/);
});

test('a spawning call names only the settings it carries', async () => {
  const call = configuredCall({ agent: 'reviewer', effort: 'high' });
  const window = await open();
  await deliver(window, [asked, event(2, { type: 'tool.started', call })]);

  const spawn = block(window);
  assert.notEqual(spawn, null);
  assert.equal(meta(spawn)?.textContent, '· reviewer · high');
  assert.equal(toggle(spawn)?.textContent, 'Spawning · reviewer · high');
  // Open while it runs: the prompt stays readable.
  assert.match(spawn?.textContent ?? '', /Audit the contrast/);
});

/** The element the header's label stands in: its verb and nothing beside it. */
const labelHolder = (spawn: HTMLElement | null): Element | null =>
  toggle(spawn)?.querySelector('span.font-normal')?.parentElement ?? null;

test('a spawn that names no settings keeps its header to the verb alone', async () => {
  const settled = await open();
  await deliver(settled, [asked, spawning, spawned]);

  const finished = block(settled);
  assert.notEqual(finished, null);
  assert.equal(toggle(finished)?.textContent, 'Spawned');
  assert.equal(meta(finished), null);
  const holder = labelHolder(finished);
  assert.equal(holder?.children.length, 1);
  assert.equal(holder?.firstElementChild?.matches('span.font-normal'), true);

  await settled.close();
  opened = undefined;

  const running = await open();
  await deliver(running, [asked, spawning]);

  const spawn = block(running);
  assert.notEqual(spawn, null);
  assert.equal(toggle(spawn)?.textContent, 'Spawning');
  assert.equal(meta(spawn), null);
  assert.equal(labelHolder(spawn)?.children.length, 1);
});
