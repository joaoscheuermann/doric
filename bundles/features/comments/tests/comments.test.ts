// `comments/v1`: the anchored annotation, its durable events and the fact that
// the registry never interprets a target.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { type CommentTarget, commentsHarness } from './support/harness.js';

const onElement: CommentTarget = {
  kind: 'artifact',
  id: 'checkout-7f3a',
  revision: 1,
  anchor: {
    form: 'source',
    path: 'src/checkout/Checkout.tsx',
    line: 42,
  },
};

const onSpace: CommentTarget = {
  kind: 'artifact',
  id: 'checkout-7f3a',
  revision: 1,
  anchor: { form: 'point', x: 412, y: 180, label: 'ul' },
};

/** The same artifact on another revision: a different target. */
const onSecondRevision: CommentTarget = {
  kind: 'artifact',
  id: 'checkout-7f3a',
  revision: 2,
  anchor: { form: 'source', path: 'src/checkout/Checkout.tsx', line: 42 },
};

describe('comments/v1.add', () => {
  test('writes the comment and publishes comments.added/v1 with the target verbatim', async () => {
    const harness = await commentsHarness();

    try {
      const comment = await harness.comments.add(
        {
          target: onElement,
          text: '  aumenta o respiro do botão  ',
          author: 'jao',
        },
        harness.call(),
      );

      assert.match(comment.commentId, /^comment-[0-9a-f]{8}$/);
      assert.equal(comment.text, 'aumenta o respiro do botão');
      assert.equal(comment.author, 'jao');
      assert.equal(comment.resolved, false);
      assert.match(comment.createdAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.deepEqual(comment.target, onElement);

      assert.equal(harness.events.appended.length, 1);

      const [appended] = harness.events.appended;

      assert.equal(appended?.type, 'comments.added/v1');
      assert.deepEqual(appended?.payload, {
        commentId: comment.commentId,
        target: onElement,
        text: 'aumenta o respiro do botão',
        author: 'jao',
      });
    } finally {
      await harness.close();
    }
  });

  test('refuses a comment without text', async () => {
    const harness = await commentsHarness();

    try {
      await assert.rejects(
        () =>
          harness.comments.add(
            { target: onElement, text: '   ' },
            harness.call(),
          ),
        /needs text/,
      );

      assert.equal(harness.events.appended.length, 0);
    } finally {
      await harness.close();
    }
  });

  test('leaves an absent author absent, in the record and in the event', async () => {
    const harness = await commentsHarness();

    try {
      const comment = await harness.comments.add(
        { target: onElement, text: 'falta espaço aqui' },
        harness.call(),
      );

      assert.equal(Object.hasOwn(comment, 'author'), false);
      assert.equal(
        Object.hasOwn(harness.events.appended[0]?.payload ?? {}, 'author'),
        false,
      );
    } finally {
      await harness.close();
    }
  });
});

describe('comments/v1.list', () => {
  test('answers the comments of a target in the order they were written', async () => {
    const harness = await commentsHarness();

    try {
      await harness.comments.add(
        { target: onElement, text: 'primeiro' },
        harness.call(),
      );
      await harness.comments.add(
        { target: onSecondRevision, text: 'segundo' },
        harness.call(),
      );
      await harness.comments.add(
        { target: onElement, text: 'terceiro' },
        harness.call(),
      );

      const all = await harness.comments.list({}, harness.call());

      assert.deepEqual(
        all.map((comment) => comment.text),
        ['primeiro', 'segundo', 'terceiro'],
      );

      const ofTarget = await harness.comments.list(
        { target: onElement },
        harness.call(),
      );

      assert.deepEqual(
        ofTarget.map((comment) => comment.text),
        ['primeiro', 'terceiro'],
      );

      const ofKind = await harness.comments.list(
        { kind: 'artifact' },
        harness.call(),
      );

      assert.equal(ofKind.length, 3);
      assert.equal(
        (await harness.comments.list({ kind: 'message' }, harness.call()))
          .length,
        0,
      );
    } finally {
      await harness.close();
    }
  });

  test('treats two anchors of one target as the same target', async () => {
    const harness = await commentsHarness();

    try {
      await harness.comments.add(
        { target: onElement, text: 'no botão' },
        harness.call(),
      );
      await harness.comments.add(
        { target: onSpace, text: 'no espaço' },
        harness.call(),
      );

      const ofTarget = await harness.comments.list(
        { target: onSpace },
        harness.call(),
      );

      assert.deepEqual(
        ofTarget.map((comment) => comment.text),
        ['no botão', 'no espaço'],
      );
      assert.deepEqual(
        ofTarget.map((comment) => comment.target.anchor.form),
        ['source', 'point'],
      );
    } finally {
      await harness.close();
    }
  });

  test('filters by a target the reader names without an anchor', async () => {
    const harness = await commentsHarness();

    try {
      await harness.comments.add(
        { target: onElement, text: 'no botão' },
        harness.call(),
      );
      await harness.comments.add(
        { target: onSecondRevision, text: 'na segunda' },
        harness.call(),
      );

      // A reader that counts or lists a target's comments names the target
      // by its identity — the anchor is not part of what `list` filters by.
      const ofTarget = await harness.comments.list(
        {
          target: {
            kind: 'artifact',
            id: 'checkout-7f3a',
            revision: 1,
          },
        },
        harness.call(),
      );

      assert.deepEqual(
        ofTarget.map((comment) => comment.text),
        ['no botão'],
      );
    } finally {
      await harness.close();
    }
  });
});

describe('comments/v1.resolve', () => {
  test('marks the comment attended and publishes comments.resolved/v1', async () => {
    const harness = await commentsHarness();

    try {
      const comment = await harness.comments.add(
        { target: onElement, text: 'ajusta o espaçamento' },
        harness.call(),
      );
      const resolved = await harness.comments.resolve(
        { commentId: comment.commentId, resolved: true },
        harness.call(),
      );

      assert.equal(resolved?.resolved, true);

      const [listed] = await harness.comments.list(
        { target: onElement },
        harness.call(),
      );

      assert.equal(listed?.resolved, true);
      assert.equal(
        harness.events.appended.at(-1)?.type,
        'comments.resolved/v1',
      );
      assert.deepEqual(harness.events.appended.at(-1)?.payload, {
        commentId: comment.commentId,
        resolved: true,
      });
    } finally {
      await harness.close();
    }
  });

  test('answers undefined for a comment it never saw', async () => {
    const harness = await commentsHarness();

    try {
      assert.equal(
        await harness.comments.resolve(
          { commentId: 'comment-00000000', resolved: true },
          harness.call(),
        ),
        undefined,
      );
    } finally {
      await harness.close();
    }
  });

  test('writes the event only when the state changes, as the fake host does', async () => {
    const harness = await commentsHarness();

    try {
      const comment = await harness.comments.add(
        { target: onElement, text: 'ajusta o espaçamento' },
        harness.call(),
      );

      // Resolve once: one event.
      await harness.comments.resolve(
        { commentId: comment.commentId, resolved: true },
        harness.call(),
      );
      assert.equal(
        harness.events.appended.filter(
          (entry) => entry.type === 'comments.resolved/v1',
        ).length,
        1,
      );

      // Resolve again, to the same state: nothing a second time.
      const again = await harness.comments.resolve(
        { commentId: comment.commentId, resolved: true },
        harness.call(),
      );

      assert.equal(again?.resolved, true);
      assert.equal(
        harness.events.appended.filter(
          (entry) => entry.type === 'comments.resolved/v1',
        ).length,
        1,
      );

      // Reopen: the state changed, so the event is written.
      const reopened = await harness.comments.resolve(
        { commentId: comment.commentId, resolved: false },
        harness.call(),
      );

      assert.equal(reopened?.resolved, false);
      assert.equal(
        harness.events.appended.filter(
          (entry) => entry.type === 'comments.resolved/v1',
        ).length,
        2,
      );
      assert.deepEqual(harness.events.appended.at(-1)?.payload, {
        commentId: comment.commentId,
        resolved: false,
      });
    } finally {
      await harness.close();
    }
  });
});
