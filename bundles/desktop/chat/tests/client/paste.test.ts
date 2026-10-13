// The conversation's paste, as the reader meets it in a window: a paste of
// paragraphs and line breaks into the prompt stays the prompt's own lines,
// so the transcript never grows a second input above the one prompt.
//
// The core paste inserts clipboard paragraphs as blocks, which splits the
// prompt: a paste at the caret leaves loose paragraphs at the root — which
// read as another input — and a paste into an empty prompt can replace it
// with the pasted blocks, a bare box the send cannot read. The
// `PasteIntoPrompt` plugin answers the paste while the selection lies in the
// prompt, writing the clipboard's text as the prompt's lines, the way Enter
// writes them.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import type { ClientContext } from 'bundle/contracts';
import {
  $createTextNode,
  $getRoot,
  $isElementNode,
  defineExtension,
  type LexicalEditor,
  type LexicalNode,
  PASTE_COMMAND,
} from 'lexical';

import { ChatLexicalV1 } from '../../src/contracts/index.js';
import { type ChatWindow, openChatWindow, settle } from './support/window.js';

const projectId = '11111111-1111-4111-8111-111111111111';
const threadId = '22222222-2222-4222-8222-222222222222';
const promptId = '33333333-3333-4333-8333-333333333333';
const url = `doric://app/projects/${projectId}/threads/${threadId}`;

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

const exchange = [
  event(1, {
    type: 'prompt.accepted',
    text: 'Where is the parser?',
    source: { kind: 'user' },
  }),
  event(2, {
    type: 'prompt.finished',
    status: 'completed',
    text: 'It lives in src/parser.ts.',
    source: { kind: 'user' },
  }),
];

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

/** The clipboard's text: two paragraphs, one holding a line break. */
const pasted = 'First paragraph\nSecond\nwith a break';

/** The paste event the window's own listener hands the editor. */
const pasteEvent = (window: ChatWindow): ClipboardEvent => {
  const DataTransferCtor =
    window.window.DataTransfer ??
    (globalThis as unknown as { DataTransfer: typeof DataTransfer })
      .DataTransfer;
  const dataTransfer = new DataTransferCtor();
  dataTransfer.setData(
    'text/html',
    `<meta charset="utf-8"><p>First paragraph</p><p>Second<br>with a break</p>`,
  );
  dataTransfer.setData('text/plain', pasted);
  return {
    clipboardData: dataTransfer as unknown as DataTransfer,
    preventDefault: () => {},
  } as unknown as ClipboardEvent;
};

/** Opens the Thread with a probe that keeps hold of its mounted editor. */
const openPastable = async (
  name: string,
  editors: Set<LexicalEditor>,
): Promise<ChatWindow> =>
  openChatWindow({
    url,
    host: host(thread()),
    probe: {
      requires: ['chat.lexical/v1@^1.0.0'],
      activate: ({ services }: ClientContext) => {
        services.use(ChatLexicalV1).registerExtension(
          defineExtension({
            name,
            register: (editor) => {
              editors.add(editor);
              return () => {
                editors.delete(editor);
              };
            },
          }),
        );
      },
    },
  });

/** The editor mounted in the window's document (StrictMode discards the other). */
const mountedEditor = (
  window: ChatWindow,
  editors: ReadonlySet<LexicalEditor>,
): LexicalEditor => {
  const editor = [...editors].find((candidate) =>
    window.document.contains(candidate.getRootElement()),
  );
  assert.ok(editor);
  return editor;
};

/** Whether a root child is the conversation's prompt block. */
const isPrompt = (node: LexicalNode): boolean =>
  node.getType() === 'user-prompt-node';

let opened: ChatWindow | undefined;
let second: ChatWindow | undefined;

afterEach(async () => {
  await opened?.close();
  await second?.close();
  opened = undefined;
  second = undefined;
});

test('a paste of paragraphs lands in the prompt as its lines', async () => {
  const editors = new Set<LexicalEditor>();
  opened = await openPastable('test/paste-lines', editors);
  await deliver(opened, exchange);
  const edit = mountedEditor(opened, editors);

  // A draft, with the caret at its end — where the paste lands.
  edit.update(() => {
    const prompt = $getRoot().getChildren().find(isPrompt);
    assert.ok($isElementNode(prompt));
    prompt.append($createTextNode('Draft'));
    prompt.selectEnd();
  });

  const handled = edit.dispatchCommand(PASTE_COMMAND, pasteEvent(opened));
  await settle(100);
  assert.equal(handled, true);

  edit.getEditorState().read(() => {
    const children = $getRoot().getChildren();
    const types = children.map((node) => node.getType());
    // The loose block the core paste would have left at the root.
    assert.equal(types.includes('paragraph'), false);
    // The prompt is the one input, and it holds everything the paste carried.
    const prompts = children.filter(isPrompt);
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0]?.getTextContent(), `Draft${pasted}`);
  });
  assert.equal(
    opened.document.querySelectorAll('[data-prompt-input]').length,
    1,
  );
});

test("a paste into the empty prompt keeps it the conversation's input", async () => {
  const editors = new Set<LexicalEditor>();
  second = await openPastable('test/paste-empty', editors);
  await deliver(second, exchange);
  const edit = mountedEditor(second, editors);

  // The caret in the empty prompt, where the window's open seats it.
  edit.update(() => {
    const prompt = $getRoot().getChildren().find(isPrompt);
    assert.ok($isElementNode(prompt));
    prompt.selectEnd();
  });

  const handled = edit.dispatchCommand(PASTE_COMMAND, pasteEvent(second));
  await settle(100);
  assert.equal(handled, true);

  edit.getEditorState().read(() => {
    const children = $getRoot().getChildren();
    const types = children.map((node) => node.getType());
    // The core paste replaces the empty prompt with the pasted blocks; the
    // answer keeps the prompt, holding the paste as its lines.
    assert.equal(types.includes('paragraph'), false);
    const prompts = children.filter(isPrompt);
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0]?.getTextContent(), pasted);
  });
  assert.equal(
    second.document.querySelectorAll('[data-prompt-input]').length,
    1,
  );
});
