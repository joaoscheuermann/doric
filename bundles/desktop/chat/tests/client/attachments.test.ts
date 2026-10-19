// Images in the conversation, as the reader meets them in a window: a prompt
// whose line names an attachment draws the image in its turn, and an image
// pasted into the prompt is attached first, then written into the prompt as
// the line its send carries.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import type { ClientContext } from 'bundle/contracts';
import {
  $getRoot,
  $isElementNode,
  defineExtension,
  type LexicalEditor,
  type LexicalNode,
  PASTE_COMMAND,
} from 'lexical';

import { ChatLexicalV1 } from '../../src/contracts/index.js';
import {
  type ChatWindow,
  type HostAnswer,
  openChatWindow,
  settle,
} from './support/window.js';

const projectId = '11111111-1111-4111-8111-111111111111';
const threadId = '22222222-2222-4222-8222-222222222222';
const promptId = '33333333-3333-4333-8333-333333333333';
const url = `doric://app/projects/${projectId}/threads/${threadId}`;

const catId = `sha256-${'c'.repeat(64)}`;
const catLine = `![cat.png](doric-attachment:${catId})`;
const catBytes = 'iVBORw0KGgo=';

const thread = () => ({
  id: threadId,
  name: 'Look at the cat',
  projectId,
  state: 'idle',
  cwd: '/workspace',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
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

const host = (
  extra: Readonly<Record<string, HostAnswer>> = {},
): Readonly<Record<string, HostAnswer>> => ({
  'runtime.threads/v1.thread': () => thread(),
  'runtime.threads/v1.queue': () => emptyQueue,
  ...extra,
});

const deliver = async (
  window: ChatWindow,
  events: readonly unknown[],
): Promise<void> => {
  const watch = window.watches().at(-1);
  assert.ok(watch);
  watch.push({
    kind: 'snapshot',
    threadId,
    projectId,
    project: null,
    thread: thread(),
    events,
  });
  await settle(150);
};

/** Opens the Thread with a probe that keeps hold of its mounted editors. */
const openWithEditors = (
  name: string,
  editors: Set<LexicalEditor>,
  answers: Readonly<Record<string, HostAnswer>>,
): Promise<ChatWindow> =>
  openChatWindow({
    url,
    host: answers,
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

const isPrompt = (node: LexicalNode): boolean =>
  node.getType() === 'user-prompt-node';

let opened: ChatWindow | undefined;

afterEach(async () => {
  await opened?.close();
  opened = undefined;
});

test("a prompt's attachment line draws its image in the turn", async () => {
  opened = await openChatWindow({
    url,
    host: host({
      'runtime.attachments/v1.read': () => ({
        id: catId,
        name: 'cat.png',
        mediaType: 'image/png',
        size: 8,
        bytes: catBytes,
      }),
    }),
  });
  await deliver(opened, [
    event(1, {
      type: 'prompt.accepted',
      text: `Look at this:\n${catLine}\nIs it a cat?`,
      source: { kind: 'user' },
    }),
  ]);
  await settle(100);

  const images = [...opened.document.querySelectorAll('img')].filter(
    (image) => image.getAttribute('alt') === 'cat.png',
  );
  assert.equal(images.length, 1);
  assert.equal(
    images[0]?.getAttribute('src'),
    `data:image/png;base64,${catBytes}`,
  );
});

test('an image pasted into the prompt is attached, then sent as its line', async () => {
  const attached: unknown[] = [];
  const editors = new Set<LexicalEditor>();
  opened = await openWithEditors(
    'test/attach-paste',
    editors,
    host({
      'runtime.attachments/v1.attach': (input) => {
        attached.push(input);
        return { id: catId, name: 'shot.png', mediaType: 'image/png', size: 4 };
      },
    }),
  );
  await deliver(opened, []);
  const edit = mountedEditor(opened, editors);
  edit.update(() => {
    const prompt = $getRoot().getChildren().find(isPrompt);
    assert.ok($isElementNode(prompt));
    prompt.selectEnd();
  });

  const file = new File([new Uint8Array([1, 2, 3, 4])], 'shot.png', {
    type: 'image/png',
  });
  const handled = edit.dispatchCommand(PASTE_COMMAND, {
    clipboardData: {
      files: [file],
      types: ['Files'],
      getData: () => '',
    },
    preventDefault: () => {},
  } as unknown as ClipboardEvent);
  await settle(150);

  assert.equal(handled, true);
  assert.deepEqual(attached, [
    { name: 'shot.png', bytes: Buffer.from([1, 2, 3, 4]).toString('base64') },
  ]);
  edit.getEditorState().read(() => {
    const prompt = $getRoot().getChildren().find(isPrompt);
    assert.ok(
      prompt
        ?.getTextContent()
        .includes(`![shot.png](doric-attachment:${catId})`),
    );
  });
});
