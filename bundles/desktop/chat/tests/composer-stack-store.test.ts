// The surface's copy of a Thread's comment stack (`stores/composer-stack`):
// what a surface reads while the reader writes a note, and what the service
// (`chat.composer/v1`) holds when a send reads it.
//
// Contract matrix:
// - a note reads as written at once, and the service is told the last edit of
//   a burst (once) within `NOTE_WRITE_DELAY`;
// - `flushNotes`, `sync` and the last release hand the service a held edit at
//   once, so whatever reads it next finds the note as written;
// - a removal wins over a held edit;
// - the echo of an older write never overwrites a note written since, while
//   an edit made elsewhere afterwards still arrives;
// - a delta that changes nothing (the prompt's words, an echo of the note
//   held) wakes no surface.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';

import type {
  ComposerFeed,
  ComposerWatchListener,
} from '../src/client/api/composer.js';
import {
  createComposerStackStore,
  NOTE_WRITE_DELAY,
} from '../src/client/stores/composer-stack.js';
import type {
  ComposerItem,
  ComposerWatchItem,
} from '../src/contracts/index.js';

const thread = { id: 'thread-1', projectId: 'project-1' };

const comment = (id: string, note: string): ComposerItem => ({
  id,
  kind: 'message',
  elementTag: 'chat-comment-line',
  data: { target: { kind: 'message', id: 'prompt-1' } },
  author: 'reader',
  note,
});

/**
 * The composer service, in memory: it holds the stack, and its echoes wait
 * until the test delivers them, as a bridge's do.
 */
const fakeService = (items: ComposerItem[]) => {
  const held = items.map((item) => ({ ...item }));
  const echoes: ComposerWatchItem[] = [];
  let listener: ComposerWatchListener | undefined;
  const feed: ComposerFeed = {
    read: async () => ({
      threadId: thread.id,
      text: '',
      items: held.map((item) => ({ ...item })),
    }),
    watch: (_thread, listen) => {
      listener = listen;
      listen({
        kind: 'snapshot',
        threadId: thread.id,
        text: '',
        items: held.map((item) => ({ ...item })),
      });
      return () => {
        listener = undefined;
      };
    },
    setText: () => undefined,
    add: async () => undefined,
    note: (_thread, id, note) => {
      const index = held.findIndex((item) => item.id === id);
      const current = held[index];
      if (current === undefined) return;
      held[index] = { ...current, note };
      echoes.push({
        kind: 'updated',
        threadId: thread.id,
        item: { ...current, note },
      });
    },
    remove: (_thread, id) => {
      const index = held.findIndex((item) => item.id === id);
      if (index < 0) return;
      held.splice(index, 1);
      echoes.push({ kind: 'removed', threadId: thread.id, id });
    },
    flushAfterSend: async () => [],
  };

  return {
    feed,
    /** The note the service holds for an item. */
    noteOf: (id: string) => held.find((item) => item.id === id)?.note,
    /** The edits the service heard, oldest first. */
    heard: () =>
      echoes.flatMap((echo) =>
        echo.kind === 'updated' ? [echo.item.note] : [],
      ),
    /** Delivers the oldest echo still on its way. */
    echo: () => {
      const next = echoes.shift();
      if (next !== undefined) listener?.(next);
    },
    /** Delivers a delta the service sent for another reason. */
    push: (delta: ComposerWatchItem) => listener?.(delta),
  };
};

const open = (items: ComposerItem[] = [comment('comment-a', '')]) => {
  const service = fakeService(items);
  const store = createComposerStackStore(service.feed);
  store.getState().retain(thread);
  const noteHere = (id: string) =>
    store
      .getState()
      .stack(thread.id)
      .find((item) => item.id === id)?.note;
  return { service, store, noteHere };
};

describe('composer stack store', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }));
  afterEach(() => mock.timers.reset());

  test('reads a note as written at once, and tells the service the last edit of a burst', () => {
    const { service, store, noteHere } = open();

    for (const note of ['n', 'no', 'not', 'note'])
      store.getState().note(thread, 'comment-a', note);

    assert.equal(noteHere('comment-a'), 'note');
    assert.equal(service.noteOf('comment-a'), '');

    mock.timers.tick(NOTE_WRITE_DELAY);
    assert.equal(service.noteOf('comment-a'), 'note');
    assert.deepEqual(service.heard(), ['note'], 'one write for the burst');
  });

  test('hands a held edit to the service at once when a send asks for it', () => {
    const { service, store } = open();
    store.getState().note(thread, 'comment-a', 'sent as written');

    store.getState().flushNotes(thread.id);

    assert.equal(service.noteOf('comment-a'), 'sent as written');
  });

  test('reads the stack back only after handing the service what was written here', async () => {
    const { service, store, noteHere } = open();
    store.getState().note(thread, 'comment-a', 'written just now');

    await store.getState().sync(thread.id);

    assert.equal(service.noteOf('comment-a'), 'written just now');
    assert.equal(noteHere('comment-a'), 'written just now');
  });

  test('keeps a note written here over a portrait read while its write is out', async () => {
    const { service, store, noteHere } = open();
    store.getState().note(thread, 'comment-a', 'first');
    store.getState().flushNotes(thread.id);
    // Written on while the read is out: the portrait states the older note.
    const read = store.getState().sync(thread.id);
    store.getState().note(thread, 'comment-a', 'first and more');
    await read;

    assert.equal(noteHere('comment-a'), 'first and more');
    mock.timers.tick(NOTE_WRITE_DELAY);
    assert.equal(service.noteOf('comment-a'), 'first and more');
  });

  test('the last release hands the service the notes written here', () => {
    const { service, store } = open();
    store.getState().retain(thread);
    store.getState().note(thread, 'comment-a', 'kept in the draft');

    store.getState().release(thread.id);
    assert.equal(service.noteOf('comment-a'), '', 'another surface holds it');
    store.getState().release(thread.id);
    assert.equal(service.noteOf('comment-a'), 'kept in the draft');
  });

  test('a removal wins over an edit still held', () => {
    const { service, store } = open();
    store.getState().note(thread, 'comment-a', 'never sent');

    store.getState().remove(thread, 'comment-a');
    mock.timers.tick(NOTE_WRITE_DELAY);

    assert.deepEqual(service.heard(), []);
    assert.equal(service.noteOf('comment-a'), undefined);
    assert.deepEqual(store.getState().stack(thread.id), []);
  });

  test('the echo of an older write never overwrites a note written since', () => {
    const { service, store, noteHere } = open();
    store.getState().note(thread, 'comment-a', 'a');
    store.getState().flushNotes(thread.id);
    store.getState().note(thread, 'comment-a', 'ab');

    // The echo of `a` arrives after `ab` was written here.
    service.echo();
    assert.equal(noteHere('comment-a'), 'ab');

    mock.timers.tick(NOTE_WRITE_DELAY);
    service.echo();
    assert.equal(noteHere('comment-a'), 'ab');
  });

  test('an edit made elsewhere after the notes written here still arrives', () => {
    const { service, store, noteHere } = open();
    store.getState().note(thread, 'comment-a', 'mine');
    store.getState().flushNotes(thread.id);
    service.echo();

    service.push({
      kind: 'updated',
      threadId: thread.id,
      item: comment('comment-a', 'from another window'),
    });

    assert.equal(noteHere('comment-a'), 'from another window');
  });

  test('a delta that changes nothing wakes no surface', () => {
    const { service, store } = open();
    store.getState().note(thread, 'comment-a', 'held');
    store.getState().flushNotes(thread.id);
    let woken = 0;
    const unsubscribe = store.subscribe(() => {
      woken += 1;
    });

    // The prompt's words are the editor's, and the echo states the note held.
    service.push({ kind: 'text', threadId: thread.id, text: 'words' });
    service.echo();

    unsubscribe();
    assert.equal(woken, 0);
  });
});
