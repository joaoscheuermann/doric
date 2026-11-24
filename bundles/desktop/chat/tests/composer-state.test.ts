// The composer's state machine (`src/shared/composer-state.ts`), the one both
// the desktop part and the host part of `chat` run: the draft's revision, the
// flush of one draft while its owners' flushes await (they cross a process
// hop once the host serves the composer), the flush a kind finds through
// `flushOf`, and the rules every send keeps. Every case reads the state the
// way its callers do — `read`, the watch items with their revision, and the
// answer of `flush` — never its insides.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ContractError } from 'bundle/contracts';
import type { CommentTarget } from 'comments/contracts';

import {
  type ComposerCommentWrite,
  type ComposerFlush,
  type ComposerItem,
  type ComposerWatchItem,
  READER_NAME,
} from '../src/contracts/index.js';
import {
  type ComposerState,
  createComposerState,
} from '../src/shared/composer-state.js';

const THREAD = 'thread-one';
const PROMPT = { threadId: THREAD, promptId: 'prompt-one' };

/** The kind every flushing case registers; `drafted` never has a flush. */
const NOTE = 'note';
const DRAFTED = 'drafted';

const target: CommentTarget = {
  kind: NOTE,
  id: 'document-one',
  anchor: { form: 'range', text: 'this sentence' },
};

/** The write a note item becomes: its note, under its own id. */
const writeOf = (item: ComposerItem): ComposerCommentWrite => ({
  target,
  text: item.note,
  commentId: item.id,
});

/** Lets every pending promise and queued task run. */
const settle = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

interface Seen {
  readonly item: ComposerWatchItem;
  readonly revision: number;
}

interface Watch {
  readonly seen: Seen[];
  dispose(): void;
}

const watchOf = (
  state: ComposerState,
  threadId: string = THREAD,
  projectId?: string,
): Watch => {
  const seen: Seen[] = [];
  const watch = state.watch(projectId, threadId, (item, revision) => {
    seen.push({ item, revision });
  });

  return { seen, dispose: () => watch.dispose() };
};

const revisionsOf = (watch: Watch): number[] =>
  watch.seen.map(({ revision }) => revision);

const removedOf = (watch: Watch): string[] =>
  watch.seen.flatMap(({ item }) => (item.kind === 'removed' ? [item.id] : []));

const addedOf = (watch: Watch): string[] =>
  watch.seen.flatMap(({ item }) =>
    item.kind === 'added' ? [item.item.id] : [],
  );

const idsOf = (items: readonly { readonly id: string }[]): string[] =>
  items.map(({ id }) => id);

const add = (
  state: ComposerState,
  kind: string,
  note = '',
  data?: unknown,
): ComposerItem =>
  state.addItem(undefined, {
    threadId: THREAD,
    kind,
    elementTag: 'test-comment-line',
    ...(data === undefined ? {} : { data }),
    note,
  });

/**
 * A flush that holds every item until `open` is called, the way a flush that
 * crosses the router awaits its answer; `calls` lists the items it was asked
 * to flush, in order.
 */
const gatedFlush = (): {
  readonly flush: ComposerFlush;
  readonly calls: ComposerItem[];
  open(): void;
} => {
  const calls: ComposerItem[] = [];
  let open = (): void => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });

  return {
    calls,
    flush: async (item) => {
      calls.push(item);
      await gate;

      return [writeOf(item)];
    },
    open: () => open(),
  };
};

/** Marks when a promise settles, so a test can see that it has not yet. */
const tracked = <T>(
  promise: Promise<T>,
): { readonly promise: Promise<T>; settled(): boolean } => {
  let done = false;
  const observed = promise.then(
    (value) => {
      done = true;
      return value;
    },
    (error: unknown) => {
      done = true;
      throw error;
    },
  );

  return { promise: observed, settled: () => done };
};

describe('composer state: the revision', () => {
  test('a new draft starts at 0 and every change raises it by one', () => {
    const state = createComposerState();
    const watch = watchOf(state);

    state.setText(undefined, THREAD, 'hello');
    const item = add(state, NOTE, 'first');
    state.updateNote(undefined, THREAD, item.id, 'second');
    state.removeItem(undefined, THREAD, item.id);

    assert.deepEqual(
      watch.seen.map(({ item: seen }) => seen.kind),
      ['snapshot', 'text', 'added', 'updated', 'removed'],
    );
    assert.deepEqual(revisionsOf(watch), [0, 1, 2, 3, 4]);
  });

  test('an update or removal of an id the stack does not hold sends nothing and raises nothing', () => {
    const state = createComposerState();
    const watch = watchOf(state);

    state.updateNote(undefined, THREAD, 'comment-unknown', 'note');
    state.removeItem(undefined, THREAD, 'comment-unknown');
    state.setText(undefined, THREAD, 'after');

    assert.deepEqual(revisionsOf(watch), [0, 1]);
    assert.equal(watch.seen[1]?.item.kind, 'text');
  });

  test('setting the same text again is a change: it raises the revision', () => {
    const state = createComposerState();
    const watch = watchOf(state);

    state.setText(undefined, THREAD, 'same');
    state.setText(undefined, THREAD, 'same');

    assert.deepEqual(revisionsOf(watch), [0, 1, 2]);
  });

  test('a watch started later sees the current revision on its snapshot, then counts on with the others', () => {
    const state = createComposerState();
    // Changes before any watch count too: the draft exists from its first write.
    state.setText(undefined, THREAD, 'one');
    add(state, NOTE, 'note');
    const first = watchOf(state);
    state.setText(undefined, THREAD, 'two');
    const second = watchOf(state);
    state.setText(undefined, THREAD, 'three');

    assert.deepEqual(revisionsOf(first), [2, 3, 4]);
    assert.deepEqual(revisionsOf(second), [3, 4]);
    assert.equal(second.seen[0]?.item.kind, 'snapshot');
  });

  test('two drafts count apart, by Thread and by Project', () => {
    const state = createComposerState();
    const one = watchOf(state, 'thread-one');
    const two = watchOf(state, 'thread-two');
    const otherProject = watchOf(state, 'thread-one', 'project-two');

    state.setText(undefined, 'thread-one', 'a');
    state.setText(undefined, 'thread-one', 'b');
    state.setText(undefined, 'thread-two', 'c');
    state.setText('project-two', 'thread-one', 'd');

    assert.deepEqual(revisionsOf(one), [0, 1, 2]);
    assert.deepEqual(revisionsOf(two), [0, 1]);
    assert.deepEqual(revisionsOf(otherProject), [0, 1]);
  });
});

describe('composer state: a flush that awaits', () => {
  test('an item added while the flush awaits is not flushed by it and stays drafted', async () => {
    const state = createComposerState();
    const gated = gatedFlush();
    state.registerFlush(NOTE, gated.flush);
    const sent = add(state, NOTE, 'sent');
    const watch = watchOf(state);

    const flushing = state.flush(PROMPT);
    await settle();
    const later = add(state, NOTE, 'added meanwhile');
    gated.open();
    const flushed = await flushing;

    assert.deepEqual(idsOf(flushed.map(({ item }) => item)), [sent.id]);
    assert.deepEqual(idsOf(gated.calls), [sent.id]);
    assert.deepEqual(idsOf(state.read(undefined, THREAD).items), [later.id]);
    assert.deepEqual(removedOf(watch), [sent.id]);
    assert.deepEqual(revisionsOf(watch), [1, 2, 3]);
  });

  test('a held item removed while the flush awaits stays removed and is not announced again', async () => {
    const state = createComposerState();
    const gated = gatedFlush();
    state.registerFlush(NOTE, gated.flush);
    const held = add(state, DRAFTED, 'no flush for this kind');
    const sent = add(state, NOTE, 'sent');
    const watch = watchOf(state);

    const flushing = state.flush(PROMPT);
    await settle();
    state.removeItem(undefined, THREAD, held.id);
    gated.open();
    await flushing;

    assert.deepEqual(state.read(undefined, THREAD).items, []);
    assert.deepEqual(addedOf(watch), []);
    assert.deepEqual(removedOf(watch), [held.id, sent.id]);
    assert.deepEqual(revisionsOf(watch), [2, 3, 4]);
  });

  test('two flushes of one draft at once flush each item once: the second answers nothing', async () => {
    const state = createComposerState();
    const gated = gatedFlush();
    state.registerFlush(NOTE, gated.flush);
    const sent = add(state, NOTE, 'sent');
    const watch = watchOf(state);

    const first = state.flush(PROMPT);
    const second = state.flush({ ...PROMPT, promptId: 'prompt-two' });
    await settle();
    gated.open();
    const [firstAnswer, secondAnswer] = await Promise.all([first, second]);

    assert.deepEqual(idsOf(gated.calls), [sent.id]);
    assert.deepEqual(
      firstAnswer.map(({ item, writes }) => ({ id: item.id, writes })),
      [{ id: sent.id, writes: [writeOf(sent)] }],
    );
    assert.deepEqual(secondAnswer, []);
    assert.deepEqual(removedOf(watch), [sent.id]);
    assert.deepEqual(revisionsOf(watch), [1, 2]);
    assert.deepEqual(state.read(undefined, THREAD).items, []);
  });

  test('a note edited while the flush awaits: the write keeps the note it was read with, and the item leaves', async () => {
    const state = createComposerState();
    const gated = gatedFlush();
    state.registerFlush(NOTE, gated.flush);
    const sent = add(state, NOTE, 'old note');
    const watch = watchOf(state);

    const flushing = state.flush(PROMPT);
    await settle();
    state.updateNote(undefined, THREAD, sent.id, 'new note');
    gated.open();
    const flushed = await flushing;

    assert.equal(flushed.length, 1);
    assert.equal(flushed[0]?.item.note, 'old note');
    assert.deepEqual(
      flushed[0]?.writes.map(({ text }) => text),
      ['old note'],
    );
    assert.deepEqual(state.read(undefined, THREAD).items, []);
    assert.deepEqual(removedOf(watch), [sent.id]);
    assert.deepEqual(revisionsOf(watch), [1, 2, 3]);
  });

  test('an item removed while the flush awaits is still answered, and its removal is not sent twice', async () => {
    const state = createComposerState();
    const gated = gatedFlush();
    state.registerFlush(NOTE, gated.flush);
    const sent = add(state, NOTE, 'sent');
    const watch = watchOf(state);

    const flushing = state.flush(PROMPT);
    await settle();
    state.removeItem(undefined, THREAD, sent.id);
    gated.open();
    const flushed = await flushing;

    assert.deepEqual(idsOf(flushed.map(({ item }) => item)), [sent.id]);
    assert.deepEqual(removedOf(watch), [sent.id]);
    assert.deepEqual(revisionsOf(watch), [1, 2]);
    assert.deepEqual(state.read(undefined, THREAD).items, []);
  });
});

describe('composer state: a flush that rejects', () => {
  test('the call rejects with the flush error; the stack, the revision and the watches stay as they were', async () => {
    const state = createComposerState();
    const failure = new ContractError('unavailable', 'The owner is gone.');
    state.registerFlush(NOTE, () => Promise.reject(failure));
    const kept = add(state, NOTE, 'kept');
    const watch = watchOf(state);

    await assert.rejects(state.flush(PROMPT), (error) => error === failure);

    assert.deepEqual(state.read(undefined, THREAD).items, [kept]);
    assert.deepEqual(revisionsOf(watch), [1]);
    state.setText(undefined, THREAD, 'next');
    assert.deepEqual(revisionsOf(watch), [1, 2]);
  });

  test('a flush queued behind a rejecting one waits for it, then runs and succeeds', async () => {
    const state = createComposerState();
    const failure = new ContractError('unavailable', 'The owner is gone.');
    let open = (): void => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let calls = 0;
    state.registerFlush(NOTE, async (item) => {
      calls += 1;
      if (calls === 1) {
        await gate;
        throw failure;
      }

      return [writeOf(item)];
    });
    const sent = add(state, NOTE, 'sent');

    const first = tracked(state.flush(PROMPT));
    const second = tracked(state.flush({ ...PROMPT, promptId: 'prompt-two' }));
    // Keep the first rejection observed before it is asserted.
    first.promise.catch(() => {});
    await settle();

    assert.equal(second.settled(), false);

    open();
    await assert.rejects(first.promise, (error) => error === failure);
    const flushed = await second.promise;

    assert.deepEqual(idsOf(flushed.map(({ item }) => item)), [sent.id]);
    assert.deepEqual(state.read(undefined, THREAD).items, []);
  });
});

describe('composer state: flushOf', () => {
  test('a kind registerFlush did not register flushes through flushOf', async () => {
    const remote: ComposerFlush = (item) => Promise.resolve([writeOf(item)]);
    const state = createComposerState(undefined, {
      flushOf: (kind) => (kind === 'remote' ? remote : undefined),
    });
    const sent = add(state, 'remote', 'through the router');

    const flushed = await state.flush(PROMPT);

    assert.deepEqual(
      flushed.map(({ item, writes }) => ({ id: item.id, writes })),
      [{ id: sent.id, writes: [writeOf(sent)] }],
    );
    assert.deepEqual(state.read(undefined, THREAD).items, []);
  });

  test('registerFlush wins over flushOf for its kind', async () => {
    const local: ComposerFlush = (item) =>
      Promise.resolve([{ ...writeOf(item), text: 'local' }]);
    const remote: ComposerFlush = (item) =>
      Promise.resolve([{ ...writeOf(item), text: 'remote' }]);
    const state = createComposerState(undefined, { flushOf: () => remote });
    state.registerFlush(NOTE, local);
    add(state, NOTE, 'note');

    const flushed = await state.flush(PROMPT);

    assert.deepEqual(
      flushed.flatMap(({ writes }) => writes.map(({ text }) => text)),
      ['local'],
    );
  });

  test('flushOf answering undefined keeps the item drafted', async () => {
    const state = createComposerState(undefined, { flushOf: () => undefined });
    const kept = add(state, 'unowned', 'note');

    const flushed = await state.flush(PROMPT);

    assert.deepEqual(flushed, []);
    assert.deepEqual(state.read(undefined, THREAD).items, [kept]);
  });

  test('flushOf is read when the flush runs: a kind that gained a flush after the item was added flushes', async () => {
    const known = new Map<string, ComposerFlush>();
    const state = createComposerState(undefined, {
      flushOf: (kind) => known.get(kind),
    });
    const sent = add(state, 'late', 'note');
    known.set('late', (item) => Promise.resolve([writeOf(item)]));

    const flushed = await state.flush(PROMPT);

    assert.deepEqual(idsOf(flushed.map(({ item }) => item)), [sent.id]);
    assert.deepEqual(state.read(undefined, THREAD).items, []);
  });
});

describe('composer state: the rules every send keeps', () => {
  test('a put-back id is kept only with the prefix and a body, and only when the stack does not hold it', () => {
    const state = createComposerState();

    const putBack = state.addItem(undefined, {
      threadId: THREAD,
      id: 'comment-put-back',
      kind: NOTE,
      elementTag: 'test-comment-line',
    });
    const prefixOnly = state.addItem(undefined, {
      threadId: THREAD,
      id: 'comment-',
      kind: NOTE,
      elementTag: 'test-comment-line',
    });
    const held = state.addItem(undefined, {
      threadId: THREAD,
      id: 'comment-put-back',
      kind: NOTE,
      elementTag: 'test-comment-line',
    });
    const foreign = state.addItem(undefined, {
      threadId: THREAD,
      id: 'other-id',
      kind: NOTE,
      elementTag: 'test-comment-line',
    });
    const absent = add(state, NOTE);

    assert.equal(putBack.id, 'comment-put-back');
    for (const assigned of [prefixOnly, held, foreign, absent]) {
      assert.match(assigned.id, /^comment-.+/);
      assert.notEqual(assigned.id, 'comment-put-back');
    }
    assert.equal(new Set(idsOf(state.read(undefined, THREAD).items)).size, 5);
  });

  test('an item nobody signed is the reader’s, with an empty note', () => {
    const state = createComposerState();

    const item = state.addItem(undefined, {
      threadId: THREAD,
      kind: NOTE,
      elementTag: 'test-comment-line',
    });

    assert.equal(item.author, READER_NAME);
    assert.equal(item.note, '');
  });

  test('a reply whose root stays drafted stays with it; a reply whose root is flushed is flushed after it', async () => {
    const state = createComposerState();
    state.registerFlush(NOTE, (item) => Promise.resolve([writeOf(item)]));
    const heldRoot = add(state, DRAFTED, 'root without a flush');
    const heldReply = add(state, NOTE, 'reply', { inReplyTo: heldRoot.id });
    const root = add(state, NOTE, 'root');
    const reply = add(state, NOTE, 'reply', { inReplyTo: root.id });

    const flushed = await state.flush(PROMPT);

    assert.deepEqual(idsOf(flushed.map(({ item }) => item)), [
      root.id,
      reply.id,
    ]);
    assert.deepEqual(idsOf(state.read(undefined, THREAD).items), [
      heldRoot.id,
      heldReply.id,
    ]);
  });

  test('a second flush of a kind is a registration_conflict naming the kind', () => {
    const state = createComposerState();
    const flush: ComposerFlush = () => Promise.resolve([]);
    state.registerFlush(NOTE, flush);

    assert.throws(
      () => state.registerFlush(NOTE, flush),
      (error: unknown) =>
        error instanceof ContractError &&
        error.code === 'registration_conflict' &&
        error.message === 'The note comment kind already has a flush.' &&
        JSON.stringify(error.details) === JSON.stringify({ kind: NOTE }),
    );
  });

  test('a disposed registration frees its kind; the flushes given at creation are registered', async () => {
    const given: ComposerFlush = (item) => Promise.resolve([writeOf(item)]);
    const state = createComposerState(new Map([[NOTE, given]]));

    assert.throws(() => state.registerFlush(NOTE, given), ContractError);

    const other = state.registerFlush('other', given);
    other.dispose();
    other.dispose();
    const again = state.registerFlush('other', given);
    const sent = add(state, NOTE, 'note');

    assert.deepEqual(
      idsOf((await state.flush(PROMPT)).map(({ item }) => item)),
      [sent.id],
    );
    again.dispose();
  });
});
