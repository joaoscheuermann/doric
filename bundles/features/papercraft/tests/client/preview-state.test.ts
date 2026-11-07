// The pure reading of `comments.*` events (`domain/preview-state.ts`): the
// comments grouped into threads, each in the state its last word and its
// resolution leave it in.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  commentsOfEvents,
  type PreviewLogEvent,
  threadsOf,
} from '../../src/client/domain/preview-state.js';

const event = (type: string, payload: unknown): PreviewLogEvent => ({
  type,
  event: payload,
});

test('the durable comments of a preview read off the events, on every revision, in order', () => {
  const events: readonly PreviewLogEvent[] = [
    event('artifacts.created/v1', {
      artifactId: 'checkout-7f3a',
      revision: 1,
      kind: 'preview',
    }),
    event('comments.added/v1', {
      commentId: 'c1',
      text: 'o botão sumiu no escuro',
      author: 'jao',
      target: {
        kind: 'artifact',
        id: 'checkout-7f3a',
        revision: 1,
        anchor: { form: 'source', path: 'src/Checkout.tsx', line: 42 },
      },
    }),
    event('comments.added/v1', {
      commentId: 'c2',
      text: 'outro alvo',
      target: { kind: 'artifact', id: 'outro', revision: 1, anchor: {} },
    }),
    event('comments.added/v1', {
      commentId: 'c3',
      text: 'da revisão dois',
      target: {
        kind: 'artifact',
        id: 'checkout-7f3a',
        revision: 2,
        anchor: { form: 'point', x: 10, y: 10 },
      },
    }),
  ];

  const comments = commentsOfEvents(events, 'checkout-7f3a');

  // Both revisions' comments carry over; another artifact's never enter.
  assert.deepEqual(
    comments.map((comment) => [comment.commentId, comment.revision]),
    [
      ['c1', 1],
      ['c3', 2],
    ],
  );
  assert.equal(comments[0]?.author, 'jao');
  assert.deepEqual(comments[0]?.anchor, {
    form: 'source',
    path: 'src/Checkout.tsx',
    line: 42,
  });
});

const TARGET = {
  kind: 'artifact',
  id: 'checkout-7f3a',
  revision: 1,
  anchor: { form: 'source', path: 'src/Checkout.tsx', line: 42 },
};

const added = (
  commentId: string,
  promptId: string,
  extra: Record<string, unknown> = {},
): PreviewLogEvent => ({
  type: 'comments.added/v1',
  promptId,
  event: { commentId, text: commentId, target: TARGET, ...extra },
});

const resolved = (commentId: string, value: boolean): PreviewLogEvent => ({
  type: 'comments.resolved/v1',
  promptId: 'q-resolve',
  event: { commentId, resolved: value },
});

test('a thread keeps its number across revisions, and answers across them', () => {
  const on = (revision: number) => ({ ...TARGET, revision });
  const threads = threadsOf(
    commentsOfEvents(
      [
        added('c1', 'q1', { target: on(1) }),
        added('c2', 'q2', { target: on(2) }),
        // The agent answers the first thread while revision 2 is current.
        added('c3', 'q3', { target: on(2), inReplyTo: 'c1', author: 'agent' }),
      ],
      'checkout-7f3a',
    ),
  );

  assert.deepEqual(
    threads.map((thread) => [
      thread.root.commentId,
      thread.pin,
      thread.replies.map((reply) => reply.commentId),
      thread.state,
    ]),
    [
      ['c1', 1, ['c3'], 'await'],
      ['c2', 2, [], 'open'],
    ],
  );
});

test("the log names each comment's prompt, its root and its latest resolution", () => {
  const comments = commentsOfEvents(
    [
      added('c1', 'q1'),
      added('c2', 'q2', { author: 'agent', inReplyTo: 'c1' }),
      resolved('c1', true),
      resolved('c1', false),
      added('c3', 'q3'),
      resolved('c3', true),
      // A retried write of the same comment is the same comment.
      added('c3', 'q4'),
    ],
    'checkout-7f3a',
  );

  assert.deepEqual(
    comments.map((comment) => [
      comment.commentId,
      comment.promptId,
      comment.inReplyTo,
      comment.resolved,
    ]),
    [
      ['c1', 'q1', undefined, false],
      ['c2', 'q2', 'c1', false],
      ['c3', 'q3', undefined, true],
    ],
  );
});

test('comments group into threads, each root with its replies, numbered by root', () => {
  const threads = threadsOf(
    commentsOfEvents(
      [
        added('r1', 'q1'),
        added('r2', 'q1'),
        added('a1', 'q2', { author: 'agent', inReplyTo: 'r1' }),
        added('u1', 'q3', { inReplyTo: 'r1' }),
        // A reply whose root is not here has no thread to join.
        added('lost', 'q3', { inReplyTo: 'elsewhere' }),
      ],
      'checkout-7f3a',
    ),
  );

  assert.deepEqual(
    threads.map((thread) => ({
      root: thread.root.commentId,
      pin: thread.pin,
      replies: thread.replies.map((reply) => reply.commentId),
    })),
    [
      { root: 'r1', pin: 1, replies: ['a1', 'u1'] },
      { root: 'r2', pin: 2, replies: [] },
    ],
  );
});

test('a thread is open, awaits the reader once the agent spoke last, and is done once resolved', () => {
  const stateOf = (events: readonly PreviewLogEvent[]) =>
    threadsOf(commentsOfEvents(events, 'checkout-7f3a'))[0]?.state;

  // Only the reader spoke.
  assert.equal(stateOf([added('r1', 'q1')]), 'open');
  // The agent answered last.
  assert.equal(
    stateOf([
      added('r1', 'q1'),
      added('a1', 'q2', { author: 'agent', inReplyTo: 'r1' }),
    ]),
    'await',
  );
  // The reader answered the agent.
  assert.equal(
    stateOf([
      added('r1', 'q1'),
      added('a1', 'q2', { author: 'agent', inReplyTo: 'r1' }),
      added('u1', 'q3', { inReplyTo: 'r1' }),
    ]),
    'open',
  );
  // Resolved, whoever spoke last.
  assert.equal(
    stateOf([
      added('r1', 'q1'),
      added('a1', 'q2', { author: 'agent', inReplyTo: 'r1' }),
      resolved('r1', true),
    ]),
    'done',
  );
  // Reopened: back to who spoke last.
  assert.equal(
    stateOf([
      added('r1', 'q1'),
      added('a1', 'q2', { author: 'agent', inReplyTo: 'r1' }),
      resolved('r1', true),
      resolved('r1', false),
    ]),
    'await',
  );
});

test('a comment on another kind of target with the same id lists nothing', () => {
  const events: readonly PreviewLogEvent[] = [
    event('comments.added/v1', {
      commentId: 'old',
      text: 'an old artifact comment',
      target: { kind: 'artifact', id: 'checkout', revision: 1, anchor: {} },
    }),
  ];

  assert.deepEqual(
    commentsOfEvents(events, 'checkout', 'papercraft-program'),
    [],
  );
});
