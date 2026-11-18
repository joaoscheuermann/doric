// A Thread's tab icon, as the layout's tab strip draws it from bundle
// isolation 4a: the chat defines `<chat-thread-tab-icon>`, which reads the
// Thread from `runtime.records/v1` and draws the icon of its kind (spec §10,
// the icon part of T4.10 pulled into change 2, decision O8).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';

import { type ClientContext, UiV1 } from 'bundle/contracts';
import type { Thread } from 'runtime/contracts';

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

test('the chat requires runtime.records/v1@^1.0.0 at version 1.8.2 (spec §10)', () => {
  const manifest = JSON.parse(
    readFileSync('bundles/desktop/chat/manifest.json', 'utf8'),
  ) as { version: string; requires: string[]; optional: string[] };

  assert.equal(manifest.version, '1.8.2');
  assert.ok(manifest.requires.includes('runtime.records/v1@^1.0.0'));
  assert.ok(!manifest.optional.includes('runtime.records/v1'));
});
