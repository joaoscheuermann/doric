import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  applyThreadUpdate,
  emptyThreadChats,
  MAX_OPEN_THREADS,
  openThread,
  showThread,
  startPending,
  type ThreadChatEffect,
  type ThreadChats,
} from '../src/domain/thread-chats';
import type {
  Thread,
  ThreadEvent,
  ThreadHistory,
  ThreadUpdate,
} from '../src/domain/workspace';

const thread = (id: string): Thread => ({
  id,
  name: id,
  projectId: 'project',
  state: 'idle',
  cwd: '/workspace/doric',
  createdAt: 't0',
  updatedAt: 't0',
});

const event = (
  threadId: string,
  sequence: number,
  payload: unknown = {},
): ThreadEvent => ({
  projectId: 'project',
  threadId,
  promptId: 'prompt',
  sequence,
  type: 'test',
  event: payload,
  createdAt: 't0',
});

const eventUpdate = (threadId: string, sequence: number): ThreadUpdate => ({
  kind: 'event',
  event: event(threadId, sequence),
});

const history = (id: string, sequences: readonly number[]): ThreadHistory => ({
  thread: thread(id),
  lastSequence: sequences.at(-1) ?? 0,
  events: sequences.map((sequence) => event(id, sequence)),
});

/**
 * A double for `window.doric.threads`: it hands back the cached history an open
 * asks for, keeps the watch each open establishes, and can deliver one Thread's
 * update into that watch. `opened` and `closed` are what a test reads to see
 * which Threads the surface is subscribed to and from where.
 */
class FakeThreads {
  readonly opened: { readonly id: string; readonly afterSequence: number }[] =
    [];
  readonly closed: string[] = [];
  private readonly watchers = new Map<string, (update: ThreadUpdate) => void>();

  constructor(
    private readonly histories: ReadonlyMap<
      string,
      ThreadHistory | null
    > = new Map(),
  ) {}

  history = (id: string): ThreadHistory | null =>
    this.histories.get(id) ?? null;

  watch = (
    id: string,
    afterSequence: number,
    listener: (update: ThreadUpdate) => void,
  ): (() => void) => {
    this.opened.push({ id, afterSequence });
    this.watchers.set(id, listener);
    return () => {
      this.closed.push(id);
      this.watchers.delete(id);
    };
  };

  /** Whether a watch is still open for the Thread. */
  watching(id: string): boolean {
    return this.watchers.has(id);
  }

  /** Delivers an update as the Thread's own watch would. */
  emit(id: string, update: ThreadUpdate): void {
    this.watchers.get(id)?.(update);
  }
}

/**
 * Drives the rules against a threads double the way the surface's store does:
 * open, show and update produce a new set of chats and a list of watches to
 * open or release, which this applies to the double.
 */
class Host {
  private state: ThreadChats = emptyThreadChats;
  private readonly releases = new Map<string, () => void>();

  constructor(private readonly threads: FakeThreads) {}

  get chats(): ThreadChats {
    return this.state;
  }

  /** What a surface would draw for the Thread: the folded log's sequences. */
  sequences = (id: string): readonly number[] =>
    (this.state.chats.get(id)?.projection.events ?? []).map(
      (item) => item.sequence,
    );

  open = (value: Thread): void => {
    this.apply(openThread(this.state, value, this.threads.history(value.id)));
  };

  show = (value: Thread): void => {
    this.apply(showThread(this.state, value));
  };

  private apply = (change: {
    readonly chats: ThreadChats;
    readonly effects: readonly ThreadChatEffect[];
  }): void => {
    this.state = change.chats;
    for (const effect of change.effects) {
      if (effect.kind === 'watch') {
        const id = effect.id;
        this.releases.set(
          id,
          this.threads.watch(id, effect.afterSequence, (update) =>
            this.apply(applyThreadUpdate(this.state, id, update)),
          ),
        );
      } else {
        this.releases.get(effect.id)?.();
        this.releases.delete(effect.id);
      }
    }
  };
}

describe('the chats the surface holds', () => {
  test('paints a Thread from its cached history, subscribed where it ends', () => {
    const threads = new FakeThreads(
      new Map([['one', history('one', [3, 4, 5])]]),
    );
    const host = new Host(threads);

    host.open(thread('one'));

    assert.deepEqual(host.sequences('one'), [3, 4, 5]);
    assert.deepEqual(threads.opened, [{ id: 'one', afterSequence: 5 }]);
  });

  test('lands an update in its Thread while another is the one shown', () => {
    const threads = new FakeThreads(
      new Map([
        ['one', history('one', [1])],
        ['two', history('two', [1])],
      ]),
    );
    const host = new Host(threads);
    host.open(thread('one'));
    host.open(thread('two'));

    // The reader is looking at two; the update belongs to one.
    host.show(thread('two'));
    const shown = host.chats.chats.get('two');

    threads.emit('one', eventUpdate('one', 2));

    assert.deepEqual(host.sequences('one'), [1, 2]);
    assert.equal(host.chats.chats.get('two'), shown);
  });

  test('keeps both transcripts and both watches across a switch', () => {
    const threads = new FakeThreads(
      new Map([
        ['one', history('one', [1, 2])],
        ['two', history('two', [1])],
      ]),
    );
    const host = new Host(threads);
    host.open(thread('one'));
    host.open(thread('two'));
    const one = host.chats.chats.get('one')?.projection;

    // Switch back to one: nothing is read again and its watch is left open.
    host.show(thread('one'));

    assert.equal(host.chats.chats.get('one')?.projection, one);
    assert.equal(
      threads.opened.filter((watch) => watch.id === 'one').length,
      1,
    );

    threads.emit('one', eventUpdate('one', 3));
    threads.emit('two', eventUpdate('two', 2));

    assert.deepEqual(host.sequences('one'), [1, 2, 3]);
    assert.deepEqual(host.sequences('two'), [1, 2]);
  });

  test('evicts the least recently viewed Thread and re-subscribes it', () => {
    const threads = new FakeThreads(new Map([['t0', history('t0', [1, 2])]]));
    const host = new Host(threads);
    const ids = Array.from(
      { length: MAX_OPEN_THREADS + 1 },
      (_, index) => `t${index}`,
    );

    for (const id of ids) host.open(thread(id));

    // The first opened is the least recently viewed, so it is the one dropped.
    assert.equal(host.chats.chats.has('t0'), false);
    assert.deepEqual(threads.closed, ['t0']);
    assert.equal(threads.watching('t0'), false);
    assert.equal(threads.watching('t1'), true);

    host.open(thread('t0'));

    assert.deepEqual(host.sequences('t0'), [1, 2]);
    assert.equal(threads.opened.filter((watch) => watch.id === 't0').length, 2);
    assert.equal(threads.watching('t0'), true);
  });

  test('drops a deleted Thread and closes its watch', () => {
    const threads = new FakeThreads(new Map([['one', history('one', [1])]]));
    const host = new Host(threads);
    host.open(thread('one'));

    threads.emit('one', {
      kind: 'deleted',
      projectId: 'project',
      threadId: 'one',
    });

    assert.equal(host.chats.chats.has('one'), false);
    assert.equal(host.chats.deleted.has('one'), true);
    assert.equal(threads.watching('one'), false);
    assert.deepEqual(threads.closed, ['one']);
  });

  test("drops a foreign event carried inside this Thread's snapshot", () => {
    const threads = new FakeThreads(
      new Map([
        ['one', history('one', [1])],
        ['two', history('two', [1])],
      ]),
    );
    const host = new Host(threads);
    host.open(thread('one'));
    host.open(thread('two'));

    threads.emit('one', {
      kind: 'snapshot',
      snapshot: {
        threadId: 'one',
        projectId: 'project',
        project: null,
        thread: thread('one'),
        events: [event('one', 5), event('two', 6)],
      },
    });

    assert.deepEqual(
      (host.chats.chats.get('one')?.projection.events ?? []).map(
        (entry) => entry.sequence,
      ),
      [1, 5],
    );
    assert.deepEqual(
      (host.chats.chats.get('two')?.projection.events ?? []).map(
        (entry) => entry.sequence,
      ),
      [1],
    );
  });

  test('leaves a deleted Thread deleted when the surface opens it again', () => {
    const threads = new FakeThreads(new Map([['one', history('one', [1])]]));
    const host = new Host(threads);
    host.open(thread('one'));
    threads.emit('one', {
      kind: 'deleted',
      projectId: 'project',
      threadId: 'one',
    });
    const opened = threads.opened.length;

    host.open(thread('one'));

    assert.equal(host.chats.chats.has('one'), false);
    assert.equal(host.chats.deleted.has('one'), true);
    assert.equal(threads.opened.length, opened);
    assert.equal(threads.watching('one'), false);
  });

  test("ignores an update whose Thread id is not the watch's own", () => {
    const threads = new FakeThreads(
      new Map([
        ['one', history('one', [1])],
        ['two', history('two', [1])],
      ]),
    );
    const host = new Host(threads);
    host.open(thread('one'));
    host.open(thread('two'));
    const one = host.chats.chats.get('one');
    const two = host.chats.chats.get('two');

    // Every shape of update, all naming two, delivered on one's watch.
    threads.emit('one', { kind: 'updated', thread: thread('two') });
    threads.emit('one', eventUpdate('two', 7));
    threads.emit('one', {
      kind: 'snapshot',
      snapshot: {
        threadId: 'two',
        projectId: 'project',
        project: null,
        thread: thread('two'),
        events: [event('two', 7)],
      },
    });

    assert.equal(host.chats.chats.get('one'), one);
    assert.equal(host.chats.chats.get('two'), two);
  });

  test('draws a stream failure in the Thread whose watch raised it', () => {
    const threads = new FakeThreads(
      new Map([
        ['one', history('one', [1])],
        ['two', history('two', [1])],
      ]),
    );
    const host = new Host(threads);
    host.open(thread('one'));
    host.open(thread('two'));

    threads.emit('two', {
      kind: 'error',
      threadId: 'two',
      message: 'The Thread event stream failed.',
    });

    assert.equal(
      host.chats.chats.get('two')?.error,
      'The Thread event stream failed.',
    );
    assert.equal(host.chats.chats.get('one')?.error, undefined);

    // A failure named for another Thread is not this watch's to draw either.
    threads.emit('one', {
      kind: 'error',
      threadId: 'two',
      message: 'The Thread event stream failed.',
    });
    assert.equal(host.chats.chats.get('one')?.error, undefined);
  });

  test('keeps the pending words of one Thread while another is settled', () => {
    const both = openThread(
      openThread(emptyThreadChats, thread('one'), null).chats,
      thread('two'),
      null,
    ).chats;

    const pendingOne = startPending(both, 'one', 'first');
    const pendingBoth = startPending(pendingOne, 'two', 'second');
    assert.equal(pendingBoth.chats.get('one')?.pending?.text, 'first');
    assert.equal(pendingBoth.chats.get('two')?.pending?.text, 'second');

    // one's own log now holds the prompt it was waiting for.
    const settled = applyThreadUpdate(pendingBoth, 'one', {
      kind: 'event',
      event: event('one', 1, { type: 'prompt.accepted', text: 'first' }),
    });

    assert.equal(settled.chats.chats.get('one')?.pending, undefined);
    assert.equal(settled.chats.chats.get('two')?.pending?.text, 'second');
  });
});
