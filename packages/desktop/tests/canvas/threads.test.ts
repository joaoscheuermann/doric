// The threads of an artifact (`desktop/ui/canvas`), generic in the owner's
// anchor: the durable comments read off a Thread's log, where each thread
// stands, and how replies group under their root. The anchor here is a
// stand-in owner's `{ cell }`: the canvas never looks inside it.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  type CanvasComment,
  type CanvasLogEvent,
  commentsOfEvents,
  threadStateOf,
  threadsOf,
} from 'desktop/ui/canvas';

interface Cell {
  readonly cell: string;
}

const added = (
  payload: Record<string, unknown>,
  log: { readonly promptId?: string; readonly createdAt?: string } = {},
): CanvasLogEvent => ({ type: 'comments.added/v1', event: payload, ...log });

const resolvedEvent = (
  commentId: string,
  resolved: boolean,
): CanvasLogEvent => ({
  type: 'comments.resolved/v1',
  event: { commentId, resolved },
});

const comment = (
  commentId: string,
  fields: Partial<CanvasComment<Cell>> = {},
): CanvasComment<Cell> => ({
  commentId,
  text: commentId,
  resolved: false,
  ...fields,
});

describe('commentsOfEvents', () => {
  const target = (id: string, cell: string) => ({
    kind: 'artifact',
    id,
    revision: 2,
    anchor: { cell },
  });

  const events: CanvasLogEvent[] = [
    added(
      {
        commentId: 'c1',
        text: 'first',
        author: 'ana',
        target: target('a1', 'B2'),
      },
      { promptId: 'prompt-1', createdAt: '2026-10-01T10:00:00.000Z' },
    ),
    added({ commentId: 'x1', text: 'elsewhere', target: target('a2', 'A1') }),
    // A retried write: the same comment, the first one stays.
    added({ commentId: 'c1', text: 'retried', target: target('a1', 'B2') }),
    { type: 'agent.text', event: { text: 'not a comment' } },
    added(
      {
        commentId: 'c2',
        text: 'answer',
        author: 'agent',
        inReplyTo: 'c1',
        target: target('a1', 'B2'),
      },
      { promptId: 'prompt-2' },
    ),
    resolvedEvent('c1', false),
    resolvedEvent('c1', true),
  ];

  const comments = commentsOfEvents<Cell>(events, 'a1');

  test('keeps the artifact’s comments, once each, in log order', () => {
    assert.deepEqual(
      comments.map((each) => [each.commentId, each.text]),
      [
        ['c1', 'first'],
        ['c2', 'answer'],
      ],
    );
  });

  test('reads the anchor, revision, author and reply link the event recorded', () => {
    const [root, reply] = comments;
    assert.deepEqual(root?.anchor, { cell: 'B2' });
    assert.equal(root?.revision, 2);
    assert.equal(root?.author, 'ana');
    assert.equal(root?.inReplyTo, undefined);
    assert.equal(reply?.inReplyTo, 'c1');
  });

  test('takes the prompt and the time from the log event', () => {
    const [root, reply] = comments;
    assert.equal(root?.promptId, 'prompt-1');
    assert.equal(root?.createdAt, '2026-10-01T10:00:00.000Z');
    assert.equal(reply?.promptId, 'prompt-2');
  });

  test('applies the latest comments.resolved/v1 of each comment', () => {
    const [root, reply] = comments;
    assert.equal(root?.resolved, true);
    assert.equal(reply?.resolved, false);
  });

  test('an artifact nobody commented has no comments', () => {
    assert.deepEqual(commentsOfEvents<Cell>(events, 'a3'), []);
  });
});

describe('threadStateOf', () => {
  test('a resolved root is done, whoever spoke last', () => {
    assert.equal(
      threadStateOf(comment('r', { resolved: true }), [
        comment('a', { author: 'agent' }),
      ]),
      'done',
    );
  });

  test('the agent speaking last awaits the reader', () => {
    assert.equal(
      threadStateOf(comment('r', { author: 'ana' }), [
        comment('a', { author: 'agent' }),
      ]),
      'await',
    );
    assert.equal(threadStateOf(comment('r', { author: 'agent' }), []), 'await');
  });

  test('the reader speaking last leaves it open', () => {
    assert.equal(threadStateOf(comment('r', { author: 'ana' }), []), 'open');
    assert.equal(
      threadStateOf(comment('r'), [
        comment('a', { author: 'agent' }),
        comment('b', { author: 'ana' }),
      ]),
      'open',
    );
  });
});

describe('threadsOf', () => {
  const threads = threadsOf<Cell>([
    comment('r1', { anchor: { cell: 'A1' } }),
    comment('r2', { anchor: { cell: 'C3' } }),
    comment('x', { inReplyTo: 'r1', author: 'agent' }),
    comment('y', { inReplyTo: 'x' }),
    comment('orphan', { inReplyTo: 'missing' }),
    comment('p', { inReplyTo: 'q' }),
    comment('q', { inReplyTo: 'p' }),
  ]);

  test('each root heads one thread, numbered by its order', () => {
    assert.deepEqual(
      threads.map((thread) => [thread.root.commentId, thread.pin]),
      [
        ['r1', 1],
        ['r2', 2],
      ],
    );
  });

  test('replies, and replies to replies, sit under their root', () => {
    assert.deepEqual(
      threads[0]?.replies.map((reply) => reply.commentId),
      ['x', 'y'],
    );
    assert.deepEqual(threads[1]?.replies, []);
  });

  test('the state is the thread’s own', () => {
    assert.equal(threads[0]?.state, 'open');
    assert.equal(threads[1]?.state, 'open');
  });

  test('orphans and reply cycles join no thread', () => {
    const grouped = threads.flatMap((thread) => [
      thread.root.commentId,
      ...thread.replies.map((reply) => reply.commentId),
    ]);
    for (const id of ['orphan', 'p', 'q']) assert.ok(!grouped.includes(id), id);
  });
});
