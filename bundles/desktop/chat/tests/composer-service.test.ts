// `chat.composer/v1` (desktopMain): the draft text and the comment stack of
// every Thread, one state in the main process, keyed by `(projectId,
// threadId)`. These tests boot the chat bundle's own desktop part exactly as
// its build ships it, and read it the way a window does — every exposed method
// is a bridge call that answers plain data.

import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';

import {
  type ChatComposer,
  ChatComposerV1,
  type ComposerWatchItem,
} from '../src/contracts/index.js';
import { bootDesktop, type Desktop } from './support/desktop.js';

interface Watch {
  readonly items: ComposerWatchItem[];
  dispose(): void;
}

const watch = (composer: ChatComposer, threadId: string): Watch => {
  const items: ComposerWatchItem[] = [];
  const subscription = composer.watch(threadId, (item) => items.push(item));

  return {
    items,
    dispose: () => subscription.dispose(),
  };
};

const messageItem = {
  kind: 'message',
  elementTag: 'chat-comment-line',
  data: {
    target: {
      kind: 'message',
      id: 'prompt-answered',
      anchor: { form: 'range', text: 'essa resposta' },
    },
  },
  author: 'jao.scheuermann',
  note: 'essa resposta está desatualizada',
};

let desktop: Desktop | undefined;

after(async () => {
  if (desktop !== undefined) await desktop.stop();
});

describe('chat.composer/v1', () => {
  test('reads the Thread portrait: empty until written, then its words and items', async () => {
    desktop = await bootDesktop();
    const composer = desktop.services.use(ChatComposerV1);

    const empty = await composer.read({ threadId: 'thread-one' });
    assert.deepEqual(empty, {
      threadId: 'thread-one',
      text: '',
      items: [],
    });

    await composer.setText({ threadId: 'thread-one', text: 'words to send' });
    const item = await composer.addItem({
      threadId: 'thread-one',
      ...messageItem,
    });
    assert.equal(item.kind, 'message');
    assert.equal(item.note, 'essa resposta está desatualizada');

    const portrait = await composer.read({ threadId: 'thread-one' });
    assert.equal(portrait.text, 'words to send');
    assert.equal(portrait.items.length, 1);
    assert.equal(portrait.items[0]?.id, item.id);
    assert.equal(portrait.items[0]?.kind, 'message');
  });

  test('watches: the portrait first, then the live deltas', async () => {
    if (desktop === undefined) desktop = await bootDesktop();
    const composer = desktop.services.use(ChatComposerV1);
    const seen = watch(composer, 'thread-watch');

    await composer.setText({ threadId: 'thread-watch', text: 'the words' });
    const added = await composer.addItem({
      threadId: 'thread-watch',
      ...messageItem,
    });
    await composer.updateNote({
      threadId: 'thread-watch',
      id: added.id,
      note: 'a better note',
    });
    await composer.removeItem({ threadId: 'thread-watch', id: added.id });

    const kinds = seen.items.map((item) => item.kind);
    assert.deepEqual(kinds, [
      'snapshot',
      'text',
      'added',
      'updated',
      'removed',
    ]);
    const snapshot = seen.items[0];
    assert.equal(snapshot?.kind === 'snapshot' && snapshot.text, '');
    const updated = seen.items[3];
    assert.equal(
      updated?.kind === 'updated' && updated.item.note,
      'a better note',
    );
    seen.dispose();
  });

  test('keys the state by (projectId, threadId), so two Projects stay apart', async () => {
    if (desktop === undefined) desktop = await bootDesktop();
    const composer = desktop.services.use(ChatComposerV1);

    // The scope a call carries names the Project it belongs to; the same
    // thread id under two projects is two states.
    const scoped = desktop.services.use(ChatComposerV1, {
      projectId: 'project-one',
    });
    const other = desktop.services.use(ChatComposerV1, {
      projectId: 'project-two',
    });

    await scoped.setText({ threadId: 'thread-key', text: 'one project' });
    assert.equal((await other.read({ threadId: 'thread-key' })).text, '');
    // A call without a scope is its own project bucket, not either of those.
    assert.equal((await composer.read({ threadId: 'thread-key' })).text, '');
  });

  test('registers one flush per kind, and refuses a second', async () => {
    if (desktop === undefined) desktop = await bootDesktop();
    const composer = desktop.services.use(ChatComposerV1);

    // The chat itself registers the `message` flush at activation, so the
    // kind is already claimed: a second registration is the conflict.
    assert.throws(
      () =>
        composer.registerFlush({
          kind: 'message',
          flush: async () => [],
        }),
      /already has a flush/,
    );

    // Another kind is free until its owner registers one.
    const disposable = composer.registerFlush({
      kind: 'preview',
      flush: async () => [],
    });
    disposable.dispose();
    const again = composer.registerFlush({
      kind: 'preview',
      flush: async () => [],
    });
    again.dispose();
  });

  test('flushes each item through its kind, and answers the comment writes', async () => {
    if (desktop === undefined) desktop = await bootDesktop();
    const composer = desktop.services.use(ChatComposerV1);
    const seen = watch(composer, 'thread-flush');

    const item = await composer.addItem({
      threadId: 'thread-flush',
      ...messageItem,
    });
    // An item of a kind nobody registered a flush for stays drafted.
    const stranger = await composer.addItem({
      threadId: 'thread-flush',
      kind: 'preview',
      elementTag: 'papercraft-comment-line',
      data: {
        target: {
          kind: 'preview',
          id: 'p',
          anchor: { form: 'point', x: 1, y: 2 },
        },
      },
      note: 'um pino no preview',
      author: 'jao.scheuermann',
    });

    const writes = await composer.flush({
      threadId: 'thread-flush',
      promptId: 'prompt-just-accepted',
    });

    // The message flush answers one comment write, in the sender's scope.
    assert.equal(writes.length, 1);
    const write = writes[0];
    assert.deepEqual(write?.target, messageItem.data.target);
    assert.equal(write?.text, 'essa resposta está desatualizada');
    assert.equal(write?.author, 'jao.scheuermann');

    // The flushed item left; the kind without a flush stayed drafted.
    const portrait = await composer.read({ threadId: 'thread-flush' });
    assert.equal(portrait.items.length, 1);
    assert.equal(portrait.items[0]?.id, stranger.id);

    // The watch saw the stack empty into the log.
    const removal = seen.items.at(-1);
    assert.equal(removal?.kind === 'removed' && removal.id, item.id);
    seen.dispose();
  });

  test('a refused send never flushes: the stack stays where it was', async () => {
    if (desktop === undefined) desktop = await bootDesktop();
    const composer = desktop.services.use(ChatComposerV1);

    const item = await composer.addItem({
      threadId: 'thread-refused',
      ...messageItem,
    });

    // A send the host refuses never reaches the flush — the sender only
    // calls it with the acceptance in hand — so nothing here moves.
    const portrait = await composer.read({ threadId: 'thread-refused' });
    assert.equal(portrait.items.length, 1);
    assert.equal(portrait.items[0]?.id, item.id);

    // An empty flush — the acceptance of a prompt without a stack — keeps
    // everything where it was too.
    const writes = await composer.flush({
      threadId: 'thread-refused',
      promptId: 'prompt-accepted',
    });
    // The message item has a note, so its flush answers one write: this is
    // what the sender would have performed.
    assert.equal(writes.length, 1);
    // A second flush has nothing left to answer: the stack is empty.
    assert.equal(
      (
        await composer.flush({
          threadId: 'thread-refused',
          promptId: 'prompt-accepted',
        })
      ).length,
      0,
    );
  });
});
