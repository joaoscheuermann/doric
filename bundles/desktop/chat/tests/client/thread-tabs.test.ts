// The chat's Thread tabs (spec §10, T4.10). From bundle isolation 4a the chat
// defines `<chat-thread-tab-icon>`, which reads the Thread from
// `runtime.records/v1` and draws the icon of its kind (the icon part of T4.10
// pulled into change 2, decision O8). From 4(c) the chat opens the tab
// itself when `workspace.hooks/v1.onOpenThreadHook` fires, through the shell's
// `layout.tabs/v2` (a recording fake in this window), retitles it when the
// Thread is renamed and closes it when the Thread leaves a described Project;
// a tab whose Project is loading is left as it is. Rewritten from the
// layout's `tests/thread-tabs.test.ts`; the hook's definer is a made-up
// probe standing in for `workspace`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';

import {
  type ClientContext,
  defineHook,
  defineHooks,
  HooksV1,
  UiV1,
} from 'bundle/contracts';
import {
  type RuntimeRecords,
  RuntimeRecordsV1,
  type Thread,
} from 'runtime/contracts';
import type { RecordsFakeOptions } from 'runtime/testing';
import { z } from 'zod';

import { type ChatWindow, openChatWindow, settle } from './support/window.js';

const projectId = '11111111-1111-4111-8111-111111111111';

const thread = (id: string, fields: Partial<Thread> = {}): Thread => ({
  id,
  projectId,
  name: 'Named',
  state: 'ready',
  lastSequence: 0,
  cwd: '/workspace',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...fields,
});

const rootId = '22222222-2222-4222-8222-222222222221';
const untitled = thread('22222222-2222-4222-8222-222222222222', { name: '' });
const main = thread(rootId);
const agent = thread('22222222-2222-4222-8222-222222222223', {
  parentThreadId: rootId,
  origin: 'agent',
});
const child = thread('22222222-2222-4222-8222-222222222224', {
  parentThreadId: rootId,
});
const undescribedId = '22222222-2222-4222-8222-222222222229';

let opened: ChatWindow | undefined;

afterEach(async () => {
  await opened?.close();
  opened = undefined;
});

/** Opens a window whose records hold the four Threads, and a way to create elements. */
const openWithRecords = async () => {
  let create:
    | ((tag: string, props: Readonly<Record<string, unknown>>) => HTMLElement)
    | undefined;
  opened = await openChatWindow({
    url: 'doric://app/elsewhere',
    host: {},
    records: { threads: [untitled, main, agent, child] },
    probe: {
      requires: ['ui/v1@^1.0.0'],
      activate: (context: ClientContext) => {
        const ui = context.services.use(UiV1);
        create = (tag, props) => ui.create(tag, props) as HTMLElement;
      },
    },
  });
  assert.ok(create, 'The probe did not activate.');
  return { window: opened, create };
};

/** The lucide icons `element` draws, by their `lucide-*` class. */
const iconsOf = (element: Element): string[] =>
  [...element.querySelectorAll('svg')].flatMap((svg) =>
    [...svg.classList].filter(
      (name) => name.startsWith('lucide-') && name !== 'lucide-icon',
    ),
  );

test('chat-thread-tab-icon draws the icon of the Thread kind it names', async () => {
  const { window, create } = await openWithRecords();
  const cases = [
    [untitled.id, 'lucide-message-circle-dashed'],
    [main.id, 'lucide-message-circle'],
    [agent.id, 'lucide-bot-message-square'],
    [child.id, 'lucide-message-circle-plus'],
  ] as const;

  const elements = cases.map(([threadId]) => {
    const element = create('chat-thread-tab-icon', { projectId, threadId });
    window.document.body.append(element);
    return element;
  });
  await settle();

  cases.forEach(([threadId, icon], index) => {
    const element = elements[index];
    assert.ok(element);
    assert.deepEqual(iconsOf(element), [icon], `The icon of ${threadId}.`);
    const wrapper = element.querySelector('span[aria-hidden]');
    assert.ok(wrapper, `The icon of ${threadId} is not hidden from readers.`);
  });
});

test('chat-thread-tab-icon draws the bubble for a Thread the records do not describe', async () => {
  const { window, create } = await openWithRecords();

  const element = create('chat-thread-tab-icon', {
    projectId,
    threadId: undescribedId,
  });
  window.document.body.append(element);
  await settle();

  assert.deepEqual(iconsOf(element), ['lucide-message-circle']);
});

test('the chat requires runtime.records/v1@^1.0.0 and layout.tabs/v2@^2.0.0 and takes workspace.hooks/v1 as optional, at version 2.0.0 (spec §10, decision O2; 6(c) O11; 4(d); 5(a); 5(b); 5(c))', () => {
  const manifest = JSON.parse(
    readFileSync('bundles/desktop/chat/manifest.json', 'utf8'),
  ) as { version: string; requires: string[]; optional: string[] };

  assert.equal(manifest.version, '2.0.0');
  assert.ok(manifest.requires.includes('runtime.records/v1@^1.0.0'));
  assert.ok(!manifest.optional.includes('runtime.records/v1'));
  assert.ok(manifest.requires.includes('layout.tabs/v2@^2.0.0'));
  assert.ok(manifest.optional.includes('workspace.hooks/v1'));
  assert.ok(
    !manifest.requires.some((entry) => entry.startsWith('workspace.hooks/v1@')),
    'The chat requires workspace.hooks/v1.',
  );
});

// T4.10: the chat opens, retitles and closes its Thread tabs ---------------

/** `workspace.hooks/v1` as `workspace` defines it (structural: hooks match by id). */
const WorkspaceHooksV1 = defineHooks('workspace.hooks/v1', {
  onOpenThreadHook: defineHook({
    kind: 'observe',
    input: z.object({ projectId: z.string(), threadId: z.string() }).strict(),
  }),
});

const fix = thread('22222222-2222-4222-8222-222222222232', {
  name: 'Fix',
  parentThreadId: rootId,
});
const other = thread('22222222-2222-4222-8222-222222222233', { name: 'Other' });

/**
 * Opens a window whose probe defines `workspace.hooks/v1`, as `workspace`
 * does, and reaches the records the chat reads; answers a way to fire
 * `onOpenThreadHook` and the records.
 */
const openWithHook = async (records: RecordsFakeOptions) => {
  let fire:
    | ((input: { projectId: string; threadId: string }) => Promise<unknown>)
    | undefined;
  let mirror: RuntimeRecords | undefined;
  opened = await openChatWindow({
    url: 'doric://app/elsewhere',
    host: {},
    records,
    probe: {
      hooks: ['workspace.hooks/v1'],
      requires: ['hooks/v1@^1.0.0', 'runtime.records/v1@^1.0.0'],
      activate: (context: ClientContext) => {
        const handle = context.services.use(HooksV1).define(WorkspaceHooksV1);
        fire = (input) => handle.onOpenThreadHook.execute(input);
        mirror = context.services.use(RuntimeRecordsV1);
      },
    },
  });
  assert.ok(fire && mirror, 'The probe did not activate.');
  // The window reads the Threads of the Project as the workspace would.
  mirror.threads(projectId);
  await settle();
  return { window: opened, fire, records: mirror };
};

const callsTo = (window: ChatWindow, method: string) =>
  window.tabCalls().filter((call) => call.method === method);

test('T4.10: when onOpenThreadHook fires the chat opens its tab for the Thread', async () => {
  const { window, fire } = await openWithHook({ threads: [main, fix, other] });

  await fire({ projectId, threadId: fix.id });
  await settle();

  assert.deepEqual(callsTo(window, 'open'), [
    {
      method: 'open',
      input: {
        id: `thread:${fix.id}`,
        title: 'Fix',
        tag: 'chat-thread-panel',
        iconTag: 'chat-thread-tab-icon',
        openBottom: true,
        props: { projectId, threadId: fix.id },
      },
    },
  ]);
});

test('T4.10: renaming the Thread retitles its tab in every owner', async () => {
  const { window, fire, records } = await openWithHook({
    threads: [main, fix, other],
  });
  await fire({ projectId, threadId: fix.id });
  await settle();

  await records.renameThread({ threadId: fix.id, name: 'Fix 2' });
  await settle();

  assert.deepEqual(callsTo(window, 'retitle'), [
    {
      method: 'retitle',
      input: { id: `thread:${fix.id}`, title: 'Fix 2', everyOwner: true },
    },
  ]);
  assert.deepEqual(callsTo(window, 'close'), []);
});

test('T4.10: a Thread that leaves its described Project closes its tab in every owner, once', async () => {
  const { window, fire, records } = await openWithHook({
    threads: [main, fix, other],
  });
  await fire({ projectId, threadId: fix.id });
  await settle();

  await records.deleteThread({ threadId: fix.id });
  await settle();
  assert.deepEqual(callsTo(window, 'close'), [
    { method: 'close', input: { id: `thread:${fix.id}`, everyOwner: true } },
  ]);

  // A later change of the records makes no call for the closed tab.
  await records.renameThread({ threadId: other.id, name: 'Other 2' });
  await settle();
  assert.equal(callsTo(window, 'close').length, 1);
  assert.deepEqual(callsTo(window, 'retitle'), []);
});

test('T4.10: while the Project is loading its tab is left as it is', async () => {
  const { window, fire, records } = await openWithHook({
    threads: [main, fix, other],
    pending: ['threads'],
  });
  await fire({ projectId, threadId: fix.id });
  await settle();

  await records.renameThread({ threadId: other.id, name: 'Other 2' });
  await records.deleteThread({ threadId: fix.id });
  await settle();

  assert.deepEqual(callsTo(window, 'close'), []);
  assert.deepEqual(callsTo(window, 'retitle'), []);
});
