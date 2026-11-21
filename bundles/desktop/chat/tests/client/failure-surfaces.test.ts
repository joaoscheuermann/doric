// The chat's failure surfaces as the reader meets them in a window, with the
// window's `Toaster` (`desktop/ui/sonner`) mounted (error-messages.md §5.1):
//
// - T-21: the paused queue's notice offers Retry, which resumes the queue; its
//   details hold no `Time:` line, and once seen it is not announced again.
// - T-37: each toast row (send, stop, queue resume, queue remove, intent,
//   queue edit open, attach) shows one error toast with the row's id and the
//   title its failure reads with, and a repeat leaves one toast; the queue edit
//   hint keeps one toast by its id; the queue refresh failure is a compact
//   notice whose Retry reads the queue again; a failed queue edit save is a
//   compact, announced notice titled "Prompt not edited".
//
// The host answers a failure by throwing, which the window's bridge turns into
// a contract error with code `internal` — a code the chat's surfaces skip for
// their fallback code (§2.3) — unless the test names another.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import {
  type ClientContext,
  CommandsV1,
  defineCommand,
} from 'bundle/contracts';
import {
  $createTextNode,
  $getRoot,
  $isElementNode,
  defineExtension,
  type LexicalEditor,
  PASTE_COMMAND,
} from 'lexical';
import { z } from 'zod';

import { CHAT_INTENT_EVENT, ChatLexicalV1 } from '../../src/contracts/index.js';
import {
  detailsOf,
  explanationOf,
  noticesIn,
  noticesTitled,
  retryOf,
  titleOf,
} from './support/notices.js';
import { selectionProbe } from './support/selection.js';
import {
  type ChatWindow,
  type HostAnswer,
  openChatWindow,
  type Probe,
  settle,
} from './support/window.js';

const projectId = '11111111-1111-4111-8111-111111111111';
const threadId = '22222222-2222-4222-8222-222222222222';
/** The prompt the Thread runs while `threadState` is `running`. */
const activePromptId = '55555555-5555-4555-8555-555555555555';
const url = `doric://app/projects/${projectId}/threads/${threadId}`;

let threadState = 'ready';

const thread = () => ({
  id: threadId,
  name: 'Fix the parser',
  projectId,
  state: threadState,
  lastSequence: 0,
  ...(threadState === 'running' ? { activePromptId } : {}),
  cwd: '/workspace',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

const emptyQueue = { revision: 1, paused: false, stopping: false, items: [] };

/** A prompt the reader queued, which the queue lets them edit. */
const queued = (id: string, preview: string) => ({
  promptId: id,
  source: { kind: 'user' },
  label: 'jao.scheuermann',
  preview,
  acceptedAt: '2026-01-01T00:00:00.000Z',
  editable: true,
});
const firstQueued = '77777777-7777-4777-8777-777777777777';
const secondQueued = '88888888-8888-4888-8888-888888888888';

/** A failure the host answers: the bridge reads it as code `internal`. */
const refuse = (): never => {
  throw new Error('The host refused.');
};

let opened: ChatWindow | undefined;
const editors = new Set<LexicalEditor>();
let dismissToasts: (() => void) | undefined;

afterEach(async () => {
  dismissToasts?.();
  dismissToasts = undefined;
  await opened?.close();
  opened = undefined;
  editors.clear();
  threadState = 'ready';
});

const workspace = selectionProbe(thread);

/**
 * The probe: keeps the window's editors, provides `workspace.selection/v1`
 * (the selected Thread, whose record `workspace.recordsApi` answers), and
 * registers `probe.fail/v1`, a command that always fails.
 */
const probe = (): Probe => ({
  provides: workspace.provides,
  requires: ['chat.lexical/v1@^1.0.0', 'commands/v1@^1.0.0'],
  activate: (context: ClientContext) => {
    const { services } = context;
    services.use(ChatLexicalV1).registerExtension(
      defineExtension({
        name: 'test/failure-surfaces',
        register: (editor) => {
          editors.add(editor);
          return () => {
            editors.delete(editor);
          };
        },
      }),
    );
    services.use(CommandsV1).register(
      defineCommand({
        id: 'probe.fail/v1',
        input: z.unknown(),
        execute: () => {
          throw new Error('The probe could not open the note.');
        },
      }),
    );
    return workspace.activate(context);
  },
});

/** The window's toaster, and the toasts it holds. */
interface Toasts {
  /** The ids of the toasts shown now. */
  ids(): string[];
  /** The failure toasts drawn now. */
  surfaces(): HTMLElement[];
}

/** Mounts the window's `Toaster`, as the shell does, in the open window. */
const mountToaster = async (window: ChatWindow): Promise<Toasts> => {
  // Loaded once the window's globals exist, as the chat part loads them.
  const [{ createRoot }, { createElement }, sonner] = await Promise.all([
    import('react-dom/client'),
    import('react'),
    import('desktop/ui/sonner'),
  ]);
  const holder = window.document.createElement('div');
  window.document.body.append(holder);
  createRoot(holder).render(createElement(sonner.Toaster));
  await settle(50);
  dismissToasts = () => sonner.toast.dismiss();
  return {
    ids: () => sonner.toast.getToasts().map((toast) => String(toast.id)),
    surfaces: () => [
      ...window.document.querySelectorAll<HTMLElement>(
        '[data-slot="error-toast"]',
      ),
    ],
  };
};

/** Opens the Thread with `answers` over the defaults and delivers `events`. */
const open = async (
  answers: Readonly<Record<string, HostAnswer>> = {},
  events: readonly unknown[] = [],
): Promise<{ window: ChatWindow; toasts: Toasts }> => {
  opened = await openChatWindow({
    url,
    probe: probe(),
    recordsApi: workspace.recordsApi,
    host: {
      'runtime.threads/v1.thread': () => thread(),
      'runtime.threads/v1.queue': () => emptyQueue,
      'chat.composer/v1.read': () => ({ threadId, text: '', items: [] }),
      'chat.composer/v1.setText': () => undefined,
      'chat.composer/v1.flush': () => [],
      ...answers,
    },
  });
  await settle(50);
  const toasts = await mountToaster(opened);
  const watch = opened.watches().at(-1);
  assert.ok(watch, 'the conversation watches its Thread');
  watch.push({
    kind: 'snapshot',
    threadId,
    projectId,
    project: null,
    thread: thread(),
    events,
  });
  await settle(150);
  return { window: opened, toasts };
};

/** The editor the window shows the conversation in. */
const shownEditor = (): LexicalEditor => {
  const editor = [...editors].find(
    (candidate) => candidate.getRootElement()?.isConnected === true,
  );
  assert.ok(editor, 'the window shows a prompt editor');
  return editor;
};

const editorRoot = (): HTMLElement => {
  const root = shownEditor().getRootElement();
  assert.ok(root, 'the editor has its root');
  return root;
};

/** Writes the reader's words into the conversation's prompt. */
const type = async (text: string): Promise<void> => {
  shownEditor().update(() => {
    const prompt = $getRoot()
      .getChildren()
      .find((node) => node.getType() === 'user-prompt-node');
    assert.ok($isElementNode(prompt));
    prompt.clear().append($createTextNode(text));
  });
  await settle();
};

/** Presses one key on `target`, as the reader would. */
const press = async (
  target: Element,
  key: string,
  modifiers: { readonly ctrlKey?: boolean } = {},
): Promise<void> => {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...modifiers,
  });
  // A browser names the event it is dispatching as `window.event`, which the
  // editor reads to keep its own caret through a key; happy-dom does not.
  const view = target.ownerDocument.defaultView as unknown as object;
  Object.defineProperty(view, 'event', { value: event, configurable: true });
  target.dispatchEvent(event);
  Reflect.deleteProperty(view, 'event');
  await settle(20);
};

/** The window's send chord, `CmdOrCtrl+Enter`. */
const sendChord = { ctrlKey: true } as const;

/** The row of a queued prompt. */
const queueRow = (window: ChatWindow, id: string): HTMLElement => {
  const row = window.document.querySelector<HTMLElement>(
    `[data-queue-id="${id}"]`,
  );
  assert.ok(row, `the queue draws the row of ${id}`);
  return row;
};

/**
 * Asserts the one failure toast the window shows: its id, the title its
 * notice reads, and that no other toast holds the same id.
 */
const assertOneToast = (
  toasts: Toasts,
  expected: { readonly id: string; readonly title: string },
): void => {
  const surfaces = toasts.surfaces();
  assert.equal(
    surfaces.length,
    1,
    `one failure toast; toasts shown: ${toasts.ids().join(', ')}`,
  );
  const [notice] = noticesIn(surfaces[0]);
  assert.ok(notice, 'the toast holds a notice');
  assert.equal(titleOf(notice), expected.title);
  assert.deepEqual(
    toasts.ids().filter((id) => id === expected.id),
    [expected.id],
    `toasts: ${toasts.ids().join(', ')}`,
  );
};

/* ------------------------------------------------------------------ */
/* T-21: the paused queue                                              */
/* ------------------------------------------------------------------ */

const pausedQueue = (message: string) => ({
  ...emptyQueue,
  paused: true,
  error: { code: 'storage_low', message },
});

test('T-21 the paused queue offers Retry, which resumes the queue', async () => {
  const message = 'Execution paused: the disk is almost full (T-21 retry).';
  const { window } = await open({
    'runtime.threads/v1.queue': () => pausedQueue(message),
    'runtime.threads/v1.resumeQueue': () => ({
      status: 'resumed',
      thread: thread(),
    }),
  });

  const [notice] = noticesTitled(
    window.document.querySelector('chat-view'),
    'Execution paused',
  );
  assert.ok(notice, 'the paused queue draws its notice');
  assert.equal(notice.getAttribute('data-variant'), 'block');
  assert.equal(explanationOf(notice), message);
  const retry = retryOf(notice);
  assert.ok(retry, 'the paused queue offers Retry');
  retry.click();
  await settle(150);

  assert.equal(window.received('runtime.threads/v1.resumeQueue').length, 1);
});

test('T-21 the paused notice has no time and is not announced again after a remount', async () => {
  const message = 'Execution paused: the disk is almost full (T-21 remount).';
  const answers = {
    'runtime.threads/v1.queue': () => pausedQueue(message),
  };
  const first = await open(answers);
  const [shown] = noticesTitled(
    first.window.document.querySelector('chat-view'),
    'Execution paused',
  );
  assert.ok(shown, 'the paused queue draws its notice');
  assert.equal(
    shown.getAttribute('role'),
    'alert',
    'announced when first seen',
  );
  const details = await detailsOf(shown);
  assert.match(details, /^Thread: /m);
  assert.doesNotMatch(details, /^Time:/m);

  dismissToasts?.();
  await first.window.close();
  opened = undefined;
  const second = await open(answers);
  const [again] = noticesTitled(
    second.window.document.querySelector('chat-view'),
    'Execution paused',
  );
  assert.ok(again, 'the remounted queue draws its notice');
  assert.equal(again.getAttribute('role'), 'group');
});

/* ------------------------------------------------------------------ */
/* T-37: the toasts of §5.1                                            */
/* ------------------------------------------------------------------ */

test('T-37 a refused send toasts thread-send-<threadId> as "Prompt not sent", once per id', async () => {
  const { toasts } = await open({ 'runtime.threads/v1.prompt': refuse });

  await type('Go on with the parser');
  await press(editorRoot(), 'Enter', sendChord);
  await settle(150);
  assertOneToast(toasts, {
    id: `thread-send-${threadId}`,
    title: 'Prompt not sent',
  });

  await type('Go on with the parser, again');
  await press(editorRoot(), 'Enter', sendChord);
  await settle(150);
  assertOneToast(toasts, {
    id: `thread-send-${threadId}`,
    title: 'Prompt not sent',
  });
});

test('T-37 a refused stop toasts thread-stop-<threadId> as "Could not stop", once per id', async () => {
  threadState = 'running';
  const { window, toasts } = await open({ 'runtime.threads/v1.pause': refuse });

  await press(editorRoot(), 'Escape');
  await settle(150);
  assert.equal(window.received('runtime.threads/v1.pause').length, 1);
  assertOneToast(toasts, {
    id: `thread-stop-${threadId}`,
    title: 'Could not stop',
  });

  await press(editorRoot(), 'Escape');
  await settle(150);
  assertOneToast(toasts, {
    id: `thread-stop-${threadId}`,
    title: 'Could not stop',
  });
});

test('T-37 a refused queue resume toasts thread-queue-<threadId> as "Queue not updated", once per id', async () => {
  const message = 'Execution paused: the disk is almost full (T-37 resume).';
  const { window, toasts } = await open({
    'runtime.threads/v1.queue': () => pausedQueue(message),
    'runtime.threads/v1.resumeQueue': refuse,
  });
  const paused = () => {
    const [notice] = noticesTitled(
      window.document.querySelector('chat-view'),
      'Execution paused',
    );
    assert.ok(notice, 'the paused queue draws its notice');
    return notice;
  };

  retryOf(paused())?.click();
  await settle(150);
  assertOneToast(toasts, {
    id: `thread-queue-${threadId}`,
    title: 'Queue not updated',
  });

  retryOf(paused())?.click();
  await settle(150);
  assertOneToast(toasts, {
    id: `thread-queue-${threadId}`,
    title: 'Queue not updated',
  });
});

test('T-37 a refused queue removal toasts thread-queue-<threadId> as "Queue not updated", once per id', async () => {
  const { window, toasts } = await open({
    'runtime.threads/v1.queue': () => ({
      ...emptyQueue,
      items: [queued(firstQueued, 'Later')],
    }),
    'runtime.threads/v1.removeQueued': refuse,
  });

  await press(queueRow(window, firstQueued), 'Delete');
  await settle(150);
  assert.equal(window.received('runtime.threads/v1.removeQueued').length, 1);
  assertOneToast(toasts, {
    id: `thread-queue-${threadId}`,
    title: 'Queue not updated',
  });

  await press(queueRow(window, firstQueued), 'Delete');
  await settle(150);
  assertOneToast(toasts, {
    id: `thread-queue-${threadId}`,
    title: 'Queue not updated',
  });
});

test('T-37 a failed intent toasts chat-intent-<command> as "Action failed", once per id', async () => {
  const { toasts } = await open();
  const intent = () =>
    editorRoot().dispatchEvent(
      new CustomEvent(CHAT_INTENT_EVENT, {
        detail: { command: 'probe.fail/v1', input: {} },
        bubbles: true,
        composed: true,
      }),
    );

  intent();
  await settle(150);
  assertOneToast(toasts, {
    id: 'chat-intent-probe.fail/v1',
    title: 'Action failed',
  });

  intent();
  await settle(150);
  assertOneToast(toasts, {
    id: 'chat-intent-probe.fail/v1',
    title: 'Action failed',
  });
});

test('T-37 a queued prompt that cannot be read for editing toasts queue-edit-<threadId> as "Prompt not edited", once per id', async () => {
  const { window, toasts } = await open({
    'runtime.threads/v1.queue': () => ({
      ...emptyQueue,
      items: [queued(firstQueued, 'Later')],
    }),
    'runtime.threads/v1.queuedPrompt': refuse,
  });

  await press(queueRow(window, firstQueued), 'Enter');
  await settle(150);
  assert.equal(window.received('runtime.threads/v1.queuedPrompt').length, 1);
  assertOneToast(toasts, {
    id: `queue-edit-${threadId}`,
    title: 'Prompt not edited',
  });

  await press(queueRow(window, firstQueued), 'Enter');
  await settle(150);
  assertOneToast(toasts, {
    id: `queue-edit-${threadId}`,
    title: 'Prompt not edited',
  });
});

test('T-37 a queued prompt no longer editable toasts queue-edit-<threadId> with its conflict, once per id', async () => {
  const { window, toasts } = await open({
    'runtime.threads/v1.queue': () => ({
      ...emptyQueue,
      items: [queued(firstQueued, 'Later')],
    }),
    'runtime.threads/v1.queuedPrompt': () => ({
      promptId: firstQueued,
      text: 'Later',
      revision: 1,
      editable: false,
    }),
  });

  await press(queueRow(window, firstQueued), 'Enter');
  await settle(150);
  // `errorFrom('conflict', …)`: `conflict` has an entry, which heads the
  // notice (§2.3) over the fallback `queue_edit_failed`.
  assertOneToast(toasts, {
    id: `queue-edit-${threadId}`,
    title: 'Not possible right now',
  });
  const [notice] = noticesIn(toasts.surfaces()[0]);
  assert.ok(notice);
  assert.equal(explanationOf(notice), 'This prompt can no longer be edited.');

  await press(queueRow(window, firstQueued), 'Enter');
  await settle(150);
  assertOneToast(toasts, {
    id: `queue-edit-${threadId}`,
    title: 'Not possible right now',
  });
});

test('T-37 a refused attach toasts attach-image-<threadId>-<file name> as "Image not attached", once per id', async () => {
  const { toasts } = await open({
    'runtime.attachments/v1.attach': refuse,
  });
  const paste = () => {
    const editor = shownEditor();
    editor.update(() => {
      const prompt = $getRoot()
        .getChildren()
        .find((node) => node.getType() === 'user-prompt-node');
      assert.ok($isElementNode(prompt));
      prompt.selectEnd();
    });
    editor.dispatchCommand(PASTE_COMMAND, {
      clipboardData: {
        files: [
          new File([new Uint8Array([1, 2, 3, 4])], 'shot.png', {
            type: 'image/png',
          }),
        ],
        types: ['Files'],
        getData: () => '',
      },
      preventDefault: () => {},
    } as unknown as ClipboardEvent);
  };

  paste();
  await settle(150);
  assertOneToast(toasts, {
    id: `attach-image-${threadId}-shot.png`,
    title: 'Image not attached',
  });

  paste();
  await settle(150);
  assertOneToast(toasts, {
    id: `attach-image-${threadId}-shot.png`,
    title: 'Image not attached',
  });
});

/** Opens an edit of the first queued prompt, the host answering its text. */
const editingFirst = async (
  answers: Readonly<Record<string, HostAnswer>> = {},
) => {
  const opened = await open({
    'runtime.threads/v1.queue': () => ({
      ...emptyQueue,
      items: [queued(firstQueued, 'Later'), queued(secondQueued, 'After')],
    }),
    'runtime.threads/v1.queuedPrompt': () => ({
      promptId: firstQueued,
      text: 'Later',
      revision: 1,
      editable: true,
    }),
    ...answers,
  });
  await press(queueRow(opened.window, firstQueued), 'Enter');
  await settle(150);
  return opened;
};

test('T-37 two presses on another prompt while an edit is open leave one hint toast, queue-edit-hint-<threadId>', async () => {
  const { window, toasts } = await editingFirst();

  await press(queueRow(window, secondQueued), 'Enter');
  await settle(100);
  await press(queueRow(window, secondQueued), 'Enter');
  await settle(100);

  assert.deepEqual(
    toasts.ids().filter((id) => id.startsWith('queue-edit-hint')),
    [`queue-edit-hint-${threadId}`],
    `toasts: ${toasts.ids().join(', ')}`,
  );
  assert.equal(toasts.surfaces().length, 0, 'the hint is not a failure');
});

test('T-37 a refused queue edit save shows the compact, announced notice "Prompt not edited"', async () => {
  const { window } = await editingFirst({
    'runtime.threads/v1.editQueued': refuse,
  });

  await type('Later, but sooner');
  await press(editorRoot(), 'Enter', sendChord);
  await settle(150);

  assert.equal(window.received('runtime.threads/v1.editQueued').length, 1);
  const notices = noticesTitled(
    window.document.querySelector('chat-view'),
    'Prompt not edited',
  );
  assert.equal(notices.length, 1, 'the edit draws one notice');
  const [notice] = notices;
  assert.ok(notice);
  assert.equal(notice.getAttribute('data-variant'), 'compact');
  assert.equal(notice.getAttribute('role'), 'alert');
  assert.equal(retryOf(notice), null);
});

test('T-37 a failed queue refresh shows a compact notice whose Retry reads the queue again', async () => {
  let failing = false;
  const { window } = await open({
    'runtime.threads/v1.queue': () =>
      failing
        ? refuse()
        : { ...emptyQueue, items: [queued(firstQueued, 'Later')] },
  });
  queueRow(window, firstQueued);

  failing = true;
  window.connection('disconnected');
  await settle(50);
  window.connection('connected');
  // The read is retried twice, one and two seconds apart, before it fails.
  await settle(4000);

  const [notice] = noticesTitled(
    window.document.querySelector('chat-view'),
    'Queue not refreshed',
  );
  assert.ok(
    notice,
    `the failed refresh draws its notice; the queue reads: ${
      window.document.querySelector('section[aria-label="Prompt queue"]')
        ?.textContent ?? ''
    }`,
  );
  assert.equal(notice.getAttribute('data-variant'), 'compact');
  const retry = retryOf(notice);
  assert.ok(retry, 'the failed refresh offers Retry');

  failing = false;
  const before = window.received('runtime.threads/v1.queue').length;
  retry.click();
  await settle(200);
  assert.ok(
    window.received('runtime.threads/v1.queue').length > before,
    'Retry reads the queue again',
  );
  assert.equal(
    noticesTitled(
      window.document.querySelector('chat-view'),
      'Queue not refreshed',
    ).length,
    0,
  );
});
