// The stored-row readers of `comments`' registry (phase 3, S52a, C20, D2): a
// `comments.added/v1` or `comments.resolved/v1` body in today's encoding (the
// kernel's zod payload, the anchor flat with `form`) or in the message's JSON
// (`core`'s `events/v1` 1.1.0: the anchor nested by its oneof case, fields at
// their default left out) reads as the payload in today's shape. The readers
// live in `comments/contracts` (S62b), so the window's readers in `chat` and
// `papercraft` share them.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import * as contracts from '../src/contracts/index.js';
import {
  commentsAddedEvent,
  commentsAddedOf,
  commentsResolvedEvent,
  commentsResolvedOf,
} from '../src/contracts/index.js';

/** A 1.x `comments.added/v1` body without `type`, as the zod payload declares it. */
const added1x = {
  commentId: 'comment-1',
  target: {
    kind: 'artifact',
    id: 'checkout-7f3a',
    revision: 1,
    anchor: { form: 'source', path: 'src/checkout/Checkout.tsx', line: 42 },
  },
  text: 'aumenta o respiro do botão',
  author: 'jao',
  createdAt: '2026-11-23T12:00:00.000Z',
  inReplyTo: 'comment-0',
} as const;

/** The same comment as `core` stores the message's JSON: `type`, anchor nested by its case. */
const addedMessageJson = {
  type: 'comments.added/v1',
  commentId: 'comment-1',
  target: {
    kind: 'artifact',
    id: 'checkout-7f3a',
    revision: 1,
    anchor: { source: { path: 'src/checkout/Checkout.tsx', line: 42 } },
  },
  text: 'aumenta o respiro do botão',
  author: 'jao',
  createdAt: '2026-11-23T12:00:00.000Z',
  inReplyTo: 'comment-0',
};

/** Each anchor form, flat (today) and nested (the message's JSON). */
const forms = [
  {
    flat: { form: 'source', path: 'src/a.tsx' },
    nested: { source: { path: 'src/a.tsx' } },
  },
  {
    flat: { form: 'source', path: 'src/a.tsx', line: 3, pseudo: '::before' },
    nested: { source: { path: 'src/a.tsx', line: 3, pseudo: '::before' } },
  },
  {
    flat: { form: 'selector', selector: 'main > button', label: 'button' },
    nested: { selector: { selector: 'main > button', label: 'button' } },
  },
  {
    flat: { form: 'point', x: 412, y: 180, label: 'ul' },
    nested: { point: { x: 412, y: 180, label: 'ul' } },
  },
  {
    flat: {
      form: 'range',
      text: 'essa resposta',
      turn: 'agent:p:3',
      block: 2,
      at: 5,
      item: 1,
    },
    nested: {
      range: {
        text: 'essa resposta',
        turn: 'agent:p:3',
        block: 2,
        at: 5,
        item: 1,
      },
    },
  },
] as const;

test('S62b: `comments/contracts` exports both stored-row readers', () => {
  assert.equal(typeof contracts.commentsAddedOf, 'function');
  assert.equal(typeof contracts.commentsResolvedOf, 'function');
});

describe('commentsAddedOf', () => {
  test('C20: a 1.x body reads as itself, and passes today’s schema', () => {
    const read = commentsAddedOf(added1x);

    assert.deepEqual(read, added1x);
    assert.equal(commentsAddedEvent.payload.safeParse(read).success, true);
  });

  test('C20: the message’s JSON of the same comment reads as the same value', () => {
    assert.deepEqual(commentsAddedOf(addedMessageJson), added1x);
  });

  test('C20: each anchor form nested by its case reads flat, keyed by form', () => {
    for (const { flat, nested } of forms) {
      const body = {
        type: 'comments.added/v1',
        commentId: 'comment-2',
        target: { kind: 'message', id: 'prompt-1', anchor: nested },
        text: 'nota',
      };

      assert.deepEqual(
        commentsAddedOf(body),
        {
          commentId: 'comment-2',
          target: { kind: 'message', id: 'prompt-1', anchor: flat },
          text: 'nota',
        },
        JSON.stringify(nested),
      );
    }
  });

  test('C20: keys neither encoding declares, `type` included, are left out', () => {
    assert.deepEqual(
      commentsAddedOf({ ...added1x, type: 'comments.added/v1', extra: 1 }),
      added1x,
    );
    assert.deepEqual(
      commentsAddedOf({ ...addedMessageJson, extra: 1 }),
      added1x,
    );
  });

  test('C20: an empty body, an anchor without a case and a non-object read as undefined', () => {
    assert.equal(commentsAddedOf({}), undefined);
    assert.equal(
      commentsAddedOf({
        ...addedMessageJson,
        target: { kind: 'artifact', id: 'checkout-7f3a', anchor: {} },
      }),
      undefined,
    );

    for (const body of [null, undefined, 'comment', 42, true, [added1x]]) {
      assert.equal(commentsAddedOf(body), undefined, JSON.stringify(body));
    }
  });
});

describe('commentsResolvedOf', () => {
  test('C20: a message-JSON body without `resolved` reads resolved: false (a reopen)', () => {
    const read = commentsResolvedOf({
      type: 'comments.resolved/v1',
      commentId: 'comment-1',
    });

    assert.deepEqual(read, { commentId: 'comment-1', resolved: false });
    assert.equal(commentsResolvedEvent.payload.safeParse(read).success, true);
  });

  test('C20: a 1.x body reads as itself; a message-JSON resolve reads resolved: true', () => {
    for (const resolved of [true, false]) {
      assert.deepEqual(
        commentsResolvedOf({ commentId: 'comment-1', resolved }),
        { commentId: 'comment-1', resolved },
      );
    }

    assert.deepEqual(
      commentsResolvedOf({
        type: 'comments.resolved/v1',
        commentId: 'comment-1',
        resolved: true,
      }),
      { commentId: 'comment-1', resolved: true },
    );
  });

  test('C20: a non-object body reads as undefined', () => {
    for (const body of [
      null,
      undefined,
      'comment-1',
      7,
      [{ resolved: true }],
    ]) {
      assert.equal(commentsResolvedOf(body), undefined, JSON.stringify(body));
    }
  });
});
