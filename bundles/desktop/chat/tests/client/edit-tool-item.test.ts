import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { type ChatWindow, openChatWindow, settle } from './support/window.js';

const projectId = '11111111-1111-4111-8111-111111111111';
const threadId = '22222222-2222-4222-8222-222222222222';
const promptId = '33333333-3333-4333-8333-333333333333';
const url = `doric://app/projects/${projectId}/threads/${threadId}`;

const thread = (overrides: Record<string, unknown> = {}) => ({
  id: threadId,
  name: 'Edit diff truncation',
  projectId,
  state: 'idle',
  cwd: '/workspace',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

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

const emptyQueue = { revision: 1, paused: false, stopping: false, items: [] };

const host = (record: unknown) => ({
  'runtime.threads/v1.thread': () => record,
  'runtime.threads/v1.queue': () => emptyQueue,
});

const deliver = async (
  window: ChatWindow,
  events: readonly unknown[],
): Promise<void> => {
  const watch = window.watches().at(-1);
  assert.equal(watch !== undefined, true);
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

let opened: ChatWindow | undefined;

afterEach(async () => {
  await opened?.close();
  opened = undefined;
});

test('edit tool truncates diffs over 16 lines with a Show more toggle and prevents 5-digit line number wrapping', async () => {
  opened = await openChatWindow({ url, host: host(thread()) });

  const diffLines = Array.from(
    { length: 20 },
    (_, index) => `${10000 + index} +const line${index + 1} = ${index + 1};`,
  ).join('\n');

  await deliver(opened, [
    event(1, {
      type: 'prompt.accepted',
      text: 'Update src/large.ts',
      source: { kind: 'user' },
    }),
    event(2, {
      type: 'tool.started',
      call: {
        id: 'call-edit-large',
        name: 'edit',
        payload: {
          path: 'src/large.ts',
          edits: [{ oldText: '', newText: 'lines' }],
        },
      },
    }),
    event(3, {
      type: 'tool.finished',
      call: {
        id: 'call-edit-large',
        name: 'edit',
        payload: {
          path: 'src/large.ts',
          edits: [{ oldText: '', newText: 'lines' }],
        },
      },
      record: {
        output: JSON.stringify({
          success: true,
          diff: diffLines,
          first_changed_line: 10000,
        }),
      },
    }),
    event(4, {
      type: 'prompt.finished',
      status: 'completed',
      text: 'Updated src/large.ts.',
      source: { kind: 'user' },
    }),
  ]);

  const view = opened.document.querySelector('chat-view');
  assert.ok(view);

  const editTool = view.querySelector('[data-slot="edit-tool"]');
  assert.notEqual(editTool, null);

  // Header verb uses font-normal while the outer label wrapper keeps font-light.
  const trigger = editTool?.querySelector('[data-slot="collapsible-trigger"]');
  assert.notEqual(trigger, null);
  const verbSpan = trigger?.querySelector('span.font-normal');
  assert.equal(verbSpan?.textContent, 'Edited');

  // Initially renders 16 diff lines plus the "Show 4 more lines" button.
  const initialRows = editTool?.querySelectorAll(
    '[data-slot="edit-diff-line"]',
  );
  assert.equal(initialRows?.length, 16);

  // 5-digit line number span has whitespace-nowrap so numbers never wrap.
  const firstLineNumber = initialRows?.[0]?.querySelector('span');
  assert.equal(firstLineNumber?.textContent, '10000');
  assert.equal(firstLineNumber?.className.includes('whitespace-nowrap'), true);

  const moreButton = editTool?.querySelector<HTMLButtonElement>(
    '[data-slot="edit-diff-more"]',
  );
  assert.notEqual(moreButton, null);
  assert.match(moreButton?.textContent ?? '', /Show 4 more lines/);

  // Clicking "Show 4 more lines" expands all 20 lines.
  moreButton?.click();
  await settle(50);

  assert.equal(
    editTool?.querySelectorAll('[data-slot="edit-diff-line"]').length,
    20,
  );
  assert.match(
    editTool?.querySelector('[data-slot="edit-diff-more"]')?.textContent ?? '',
    /Show less/,
  );
});

test('terminal tool card renders single-line truncated command inside the card', async () => {
  opened = await openChatWindow({
    url,
    host: host(thread({ state: 'running' })),
  });

  await deliver(opened, [
    event(1, {
      type: 'prompt.accepted',
      text: 'Run tests',
      source: { kind: 'user' },
    }),
    event(2, {
      type: 'tool.started',
      call: {
        id: 'call-term-1',
        name: 'terminal',
        payload: {
          command:
            'npm test -- --watch --very-long-flag-that-truncates-on-one-line',
        },
      },
    }),
  ]);

  const view = opened.document.querySelector('chat-view');
  assert.ok(view);

  const terminalTool = view.querySelector('[data-slot="terminal-tool"]');
  assert.notEqual(terminalTool, null);

  // While running, the terminal card is open by default and shows the command on a single truncated line.
  const commandRow = terminalTool?.querySelector(
    '[data-slot="terminal-command"]',
  );
  assert.notEqual(commandRow, null);
  assert.equal(commandRow?.className.includes('truncate'), true);
});
