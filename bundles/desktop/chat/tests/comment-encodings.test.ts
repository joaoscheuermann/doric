// The two encodings a Thread's log holds for a comment row, as the
// conversation reads them (S62b, C1): today's (the kernel's zod payload, the
// anchor flat with `form`) and the message's JSON (`core`'s `events/v1` 1.1.0:
// the anchor nested by its oneof case, fields at their default left out).
// Either reads as the same turn comment and projects to the same thread; a
// row neither encoding accepts reads exactly as before.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  resolvedFrom,
  threadState,
} from '../src/client/domain/comment-threads.js';
import {
  emptyProjection,
  type Projection,
  projectEvents,
} from '../src/client/domain/projector.js';
import type { ThreadEvent } from '../src/client/domain/workspace.js';
import { turnCommentFrom } from '../src/contracts/index.js';

const event = (
  sequence: number,
  promptId: string,
  value: Readonly<Record<string, unknown> & { readonly type: string }>,
): ThreadEvent => ({
  projectId: 'project',
  threadId: 'thread',
  promptId,
  sequence,
  type: value.type,
  event: value,
  createdAt: `2026-01-01T00:00:${String(sequence).padStart(2, '0')}.000Z`,
});

const accepted = (sequence: number, promptId: string) =>
  event(sequence, promptId, {
    type: 'prompt.accepted',
    text: 'Ajusta',
    source: { kind: 'user' },
  });

const project = (events: readonly ThreadEvent[]): Projection =>
  projectEvents(emptyProjection, events);

/** The range the reader selected in one of the agent's messages. */
const range = { text: 'essa resposta', turn: 'agent:p0:3', block: 2, at: 5 };

/** The target as today's row writes it: the anchor flat, keyed by `form`. */
const flatTarget = {
  kind: 'message',
  id: 'p0',
  anchor: { form: 'range', ...range },
};

/** The same target as the message's JSON: the anchor nested by its case. */
const nestedTarget = { kind: 'message', id: 'p0', anchor: { range } };

/**
 * One comment in the three ways a log may hold it: today's JSON, the
 * message's JSON with the fields at their default left out, and the
 * message's JSON with every implicit field written.
 */
const encodings = (text: string) => ({
  today: {
    type: 'comments.added/v1',
    commentId: 'c-a',
    target: flatTarget,
    text,
    author: 'jao.scheuermann',
  },
  messageJson: {
    type: 'comments.added/v1',
    commentId: 'c-a',
    target: nestedTarget,
    ...(text === '' ? {} : { text }),
    author: 'jao.scheuermann',
  },
  messageJsonImplicit: {
    type: 'comments.added/v1',
    commentId: 'c-a',
    target: nestedTarget,
    text,
    author: 'jao.scheuermann',
  },
});

describe('a comments.added/v1 row in either encoding', () => {
  for (const text of ['aumenta o respiro', '']) {
    test(`reads as one turn comment, its anchor flat (text ${JSON.stringify(text)})`, () => {
      const rows = encodings(text);
      const expected = {
        commentId: 'c-a',
        target: flatTarget,
        text,
        author: 'jao.scheuermann',
      };

      for (const [name, row] of Object.entries(rows)) {
        assert.deepEqual(turnCommentFrom(row), expected, name);
      }
    });

    test(`projects to one comment thread (text ${JSON.stringify(text)})`, () => {
      const rows = encodings(text);
      const threadOf = (row: (typeof rows)[keyof typeof rows]) =>
        project([accepted(1, 'p1'), event(2, 'p1', row)]).threads.get('c-a');

      const today = threadOf(rows.today);
      assert.ok(today, 'today’s row opens the thread of c-a');
      assert.deepEqual(today.target, flatTarget);

      for (const name of ['messageJson', 'messageJsonImplicit'] as const) {
        const thread = threadOf(rows[name]);
        assert.deepEqual(thread, today, name);
        assert.deepEqual(thread?.target, flatTarget, name);
      }
    });
  }
});

describe('a comments.resolved/v1 row in either encoding', () => {
  test('a message-JSON reopen without `resolved` reads resolved: false', () => {
    assert.deepEqual(
      resolvedFrom({ type: 'comments.resolved/v1', commentId: 'c-a' }),
      { commentId: 'c-a', resolved: false },
    );
  });

  test('today’s rows read as before', () => {
    for (const resolved of [true, false]) {
      assert.deepEqual(
        resolvedFrom({
          type: 'comments.resolved/v1',
          commentId: 'c-a',
          resolved,
        }),
        { commentId: 'c-a', resolved },
      );
    }
  });

  test('a message-JSON reopen after a resolve opens the thread again', () => {
    const { today } = encodings('aumenta o respiro');
    const resolvedLog = [
      accepted(1, 'p1'),
      event(2, 'p1', today),
      event(3, 'p1', {
        type: 'comments.resolved/v1',
        commentId: 'c-a',
        resolved: true,
      }),
    ];
    const done = project(resolvedLog);
    const doneThread = done.threads.get('c-a');
    assert.ok(doneThread);
    assert.equal(threadState(doneThread), 'done');

    const reopened = projectEvents(done, [
      event(4, 'p1', { type: 'comments.resolved/v1', commentId: 'c-a' }),
    ]);
    const thread = reopened.threads.get('c-a');
    assert.ok(thread);
    assert.equal(thread.resolved, false);
    assert.equal(threadState(thread), 'open');
  });
});

describe('a row neither encoding accepts', () => {
  test('a comment whose target is not a CommentTarget still reads with that target', () => {
    const row = {
      type: 'comments.added/v1',
      commentId: 'c-s',
      target: 'a string',
      text: 'nota',
      author: 'jao.scheuermann',
    };

    assert.deepEqual(turnCommentFrom(row), {
      commentId: 'c-s',
      target: 'a string',
      text: 'nota',
      author: 'jao.scheuermann',
    });
    assert.equal(
      project([accepted(1, 'p1'), event(2, 'p1', row)]).threads.get('c-s')
        ?.target,
      'a string',
    );
  });
});
