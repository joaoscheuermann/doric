// `comments/v1`: the anchored annotation, its durable events, the list the
// registry folds back from the Thread log, and the fact that the registry
// never interprets a target.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  type CommentTarget,
  commentsHarness,
  promptScope,
  rowsOf,
  threadLog,
} from './support/harness.js';

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

const otherThread = { ...promptScope, threadId: 'thread-2' };
const otherProject = { ...promptScope, projectId: 'project-2' };

const codeOf = (expected: string) => (error: unknown) =>
  (error as { code?: unknown }).code === expected;

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

      assert.equal(typeof comment.commentId, 'string');
      assert.notEqual(comment.commentId, '');
      assert.equal(comment.text, 'aumenta o respiro do botão');
      assert.equal(comment.author, 'jao');
      assert.equal(comment.resolved, false);
      assert.deepEqual(comment.target, onElement);

      const added = rowsOf(harness.log, 'comments.added/v1');

      assert.equal(added.length, 1);
      assert.equal(added[0]?.threadId, promptScope.threadId);

      const payload = added[0]?.event as Record<string, unknown>;

      assert.equal(payload.commentId, comment.commentId);
      assert.deepEqual(payload.target, onElement);
      assert.equal(payload.text, 'aumenta o respiro do botão');
      assert.equal(payload.author, 'jao');
      assert.equal(payload.createdAt, comment.createdAt);
    } finally {
      await harness.close();
    }
  });

  test('gives every comment its own identity', async () => {
    const harness = await commentsHarness();

    try {
      const ids = new Set<string>();

      for (let index = 0; index < 20; index += 1) {
        const comment = await harness.comments.add(
          { target: onElement, text: `nota ${index}` },
          harness.call(),
        );
        ids.add(comment.commentId);
      }

      assert.equal(ids.size, 20);
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
        codeOf('invalid_input'),
      );

      assert.equal(harness.log.rows.length, 0);
    } finally {
      await harness.close();
    }
  });

  test('refuses an anchor that lacks the fields of its form', async () => {
    const harness = await commentsHarness();

    try {
      for (const anchor of [
        { form: 'source' },
        { form: 'source', path: '' },
        { form: 'selector' },
        { form: 'point', x: 4 },
        { form: 'range' },
        { form: 'range', text: '' },
        { form: 'elsewhere', text: 'x' },
      ]) {
        await assert.rejects(
          async () =>
            harness.comments.add(
              {
                target: { kind: 'artifact', id: 'a', anchor } as never,
                text: 'nota',
              },
              harness.call(),
            ),
          codeOf('invalid_input'),
          JSON.stringify(anchor),
        );
      }

      assert.equal(harness.log.rows.length, 0);
    } finally {
      await harness.close();
    }
  });

  test('accepts each form with its own fields, a source without a line included', async () => {
    const harness = await commentsHarness();

    try {
      for (const anchor of [
        { form: 'source', path: 'src/App.tsx' },
        { form: 'selector', selector: 'main > button', label: 'button' },
        { form: 'point', x: 0, y: 12 },
        { form: 'range', text: 'essa resposta' },
      ] as const) {
        await harness.comments.add(
          { target: { kind: 'artifact', id: 'a', anchor }, text: 'nota' },
          harness.call(),
        );
      }

      assert.equal(rowsOf(harness.log, 'comments.added/v1').length, 4);
    } finally {
      await harness.close();
    }
  });

  test('keeps the turn and block of a range anchor that names where it sits', async () => {
    const harness = await commentsHarness();
    const seated: CommentTarget = {
      kind: 'message',
      id: 'prompt-1',
      anchor: {
        form: 'range',
        text: 'essa resposta',
        turn: 'agent:p:3',
        block: 2,
      },
    };

    try {
      const comment = await harness.comments.add(
        { target: seated, text: 'nessa linha' },
        harness.call(),
      );

      assert.deepEqual(comment.target, seated);
      const listed = await harness.comments.list({}, harness.call());
      assert.deepEqual(listed[0]?.target, seated);
    } finally {
      await harness.close();
    }
  });

  test('refuses a seat that is not a 0-based block', async () => {
    const harness = await commentsHarness();

    try {
      for (const anchor of [
        { form: 'range', text: 'essa resposta', turn: 'agent:p:3', block: -1 },
        { form: 'range', text: 'essa resposta', turn: '', block: 2 },
        { form: 'range', text: 'essa resposta', turn: 'agent:p:3', block: 1.5 },
      ]) {
        await assert.rejects(
          () =>
            harness.comments.add(
              {
                target: { kind: 'message', id: 'prompt-1', anchor } as never,
                text: 'nota',
              },
              harness.call(),
            ),
          codeOf('invalid_input'),
          JSON.stringify(anchor),
        );
      }

      assert.equal(harness.log.rows.length, 0);
    } finally {
      await harness.close();
    }
  });

  test('still accepts an anchor that names no seat, so older comments keep working', async () => {
    const harness = await commentsHarness();
    const unseated: CommentTarget = {
      kind: 'message',
      id: 'prompt-1',
      anchor: { form: 'range', text: 'essa resposta' },
    };

    try {
      const comment = await harness.comments.add(
        { target: unseated, text: 'nota antiga' },
        harness.call(),
      );

      assert.deepEqual(comment.target, unseated);
      assert.deepEqual(
        (await harness.comments.list({}, harness.call()))[0]?.target,
        unseated,
      );
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
        Object.hasOwn(
          (rowsOf(harness.log, 'comments.added/v1')[0]?.event ?? {}) as object,
          'author',
        ),
        false,
      );
      assert.equal(
        Object.hasOwn(
          (await harness.comments.list({}, harness.call()))[0] ?? {},
          'author',
        ),
        false,
      );
    } finally {
      await harness.close();
    }
  });

  test('lands in the Thread of the call', async () => {
    const harness = await commentsHarness();

    try {
      await harness.comments.add(
        { target: onElement, text: 'na outra conversa' },
        harness.call(otherThread),
      );

      assert.deepEqual(
        harness.log.rows.map((row) => [row.projectId, row.threadId]),
        [['project-1', 'thread-2']],
      );
    } finally {
      await harness.close();
    }
  });

  test('refuses a call that names no prompt to write under', async () => {
    const harness = await commentsHarness();

    try {
      await assert.rejects(
        () =>
          harness.comments.add(
            { target: onElement, text: 'sem prompt' },
            harness.call({ projectId: 'project-1', threadId: 'thread-1' }),
          ),
        codeOf('invalid_scope'),
      );

      assert.equal(harness.log.rows.length, 0);
    } finally {
      await harness.close();
    }
  });

  test('leaves no comment behind when the durable append fails', async () => {
    const harness = await commentsHarness();

    try {
      harness.log.failAppends = true;

      await assert.rejects(() =>
        harness.comments.add(
          { target: onElement, text: 'perdido' },
          harness.call(),
        ),
      );

      harness.log.failAppends = false;

      assert.deepEqual(await harness.comments.list({}, harness.call()), []);
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

  test('a fresh activation still lists what an earlier one wrote', async () => {
    const log = threadLog();
    const first = await commentsHarness(log);
    let written: string;

    try {
      const comment = await first.comments.add(
        { target: onElement, text: 'sobrevive ao reinício', author: 'jao' },
        first.call(),
      );
      await first.comments.resolve(
        { commentId: comment.commentId, resolved: true },
        first.call(),
      );
      written = comment.commentId;
    } finally {
      await first.close();
    }

    const restarted = await commentsHarness(log);

    try {
      const listed = await restarted.comments.list(
        { target: onElement },
        restarted.call(),
      );

      assert.deepEqual(
        listed.map((comment) => [comment.commentId, comment.text]),
        [[written, 'sobrevive ao reinício']],
      );
      assert.equal(listed[0]?.resolved, true);
      assert.equal(listed[0]?.author, 'jao');
    } finally {
      await restarted.close();
    }
  });

  test('answers only the comments of the call’s Thread and Project', async () => {
    const harness = await commentsHarness();

    try {
      await harness.comments.add(
        { target: onElement, text: 'desta conversa' },
        harness.call(),
      );
      await harness.comments.add(
        { target: onElement, text: 'de outra conversa' },
        harness.call(otherThread),
      );
      await harness.comments.add(
        { target: onElement, text: 'de outro projeto' },
        harness.call(otherProject),
      );

      const texts = async (scope: Parameters<typeof harness.call>[0]) =>
        (await harness.comments.list({}, harness.call(scope))).map(
          (comment) => comment.text,
        );

      assert.deepEqual(await texts(promptScope), ['desta conversa']);
      assert.deepEqual(await texts(otherThread), ['de outra conversa']);
      assert.deepEqual(await texts(otherProject), ['de outro projeto']);
      // A Project-wide read covers every Thread of the Project, and only it.
      assert.deepEqual((await texts({ projectId: 'project-1' })).sort(), [
        'de outra conversa',
        'desta conversa',
      ]);
    } finally {
      await harness.close();
    }
  });

  test('refuses a read that names no Project', async () => {
    const harness = await commentsHarness();

    try {
      await assert.rejects(
        () => harness.comments.list({}, harness.call({})),
        codeOf('invalid_scope'),
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

      const rows = rowsOf(harness.log, 'comments.resolved/v1');

      assert.equal(rows.length, 1);

      const payload = (rows[0]?.event ?? {}) as Record<string, unknown>;

      assert.equal(payload.commentId, comment.commentId);
      assert.equal(payload.resolved, true);
    } finally {
      await harness.close();
    }
  });

  test('answers undefined for a comment it never saw', async () => {
    const harness = await commentsHarness();

    try {
      assert.equal(
        await harness.comments.resolve(
          { commentId: 'comment-unknown', resolved: true },
          harness.call(),
        ),
        undefined,
      );
    } finally {
      await harness.close();
    }
  });

  test('refuses to resolve a comment of another Thread or Project', async () => {
    const harness = await commentsHarness();

    try {
      const comment = await harness.comments.add(
        { target: onElement, text: 'desta conversa' },
        harness.call(),
      );

      for (const scope of [otherThread, otherProject]) {
        assert.equal(
          await harness.comments.resolve(
            { commentId: comment.commentId, resolved: true },
            harness.call(scope),
          ),
          undefined,
        );
      }

      assert.equal(rowsOf(harness.log, 'comments.resolved/v1').length, 0);

      const [listed] = await harness.comments.list({}, harness.call());

      assert.equal(listed?.resolved, false);
    } finally {
      await harness.close();
    }
  });

  test('leaves the comment open when the durable append fails', async () => {
    const harness = await commentsHarness();

    try {
      const comment = await harness.comments.add(
        { target: onElement, text: 'ajusta o espaçamento' },
        harness.call(),
      );

      harness.log.failAppends = true;

      await assert.rejects(() =>
        harness.comments.resolve(
          { commentId: comment.commentId, resolved: true },
          harness.call(),
        ),
      );

      harness.log.failAppends = false;

      const [listed] = await harness.comments.list({}, harness.call());

      assert.equal(listed?.resolved, false);
    } finally {
      await harness.close();
    }
  });

  test('writes the event only when the attended state changes', async () => {
    const harness = await commentsHarness();
    const resolvedRows = () =>
      rowsOf(harness.log, 'comments.resolved/v1').length;

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
      assert.equal(resolvedRows(), 1);

      // Resolve again, to the same state: nothing a second time.
      const again = await harness.comments.resolve(
        { commentId: comment.commentId, resolved: true },
        harness.call(),
      );

      assert.equal(again?.resolved, true);
      assert.equal(resolvedRows(), 1);

      // Reopen: the state changed, so the event is written.
      const reopened = await harness.comments.resolve(
        { commentId: comment.commentId, resolved: false },
        harness.call(),
      );

      assert.equal(reopened?.resolved, false);
      assert.equal(resolvedRows(), 2);

      const [listed] = await harness.comments.list({}, harness.call());

      assert.equal(listed?.resolved, false);
    } finally {
      await harness.close();
    }
  });
});

describe('comments/v1.add with a caller-chosen id', () => {
  test('writes the comment under the id the caller chose', async () => {
    const harness = await commentsHarness();

    try {
      const comment = await harness.comments.add(
        { target: onElement, text: 'com id', commentId: 'comment-abc_123' },
        harness.call(),
      );

      assert.equal(comment.commentId, 'comment-abc_123');
      assert.deepEqual(
        (await harness.comments.list({}, harness.call())).map(
          (listed) => listed.commentId,
        ),
        ['comment-abc_123'],
      );
    } finally {
      await harness.close();
    }
  });

  test('refuses an id outside the allowed format and writes nothing', async () => {
    const harness = await commentsHarness();

    try {
      for (const commentId of [
        '',
        'has space',
        'slash/id',
        'acentuação',
        'x'.repeat(129),
      ]) {
        // Schema refusals throw before a promise exists, hence `async`.
        await assert.rejects(
          async () =>
            harness.comments.add(
              { target: onElement, text: 'nota', commentId },
              harness.call(),
            ),
          codeOf('invalid_input'),
          JSON.stringify(commentId),
        );
      }

      assert.equal(harness.log.rows.length, 0);

      // The boundary itself is valid.
      const longest = 'x'.repeat(128);
      const comment = await harness.comments.add(
        { target: onElement, text: 'nota', commentId: longest },
        harness.call(),
      );

      assert.equal(comment.commentId, longest);
    } finally {
      await harness.close();
    }
  });

  test('is idempotent: a retried flush returns the comment and appends nothing', async () => {
    const harness = await commentsHarness();

    try {
      const first = await harness.comments.add(
        { target: onElement, text: 'uma vez', commentId: 'comment-once' },
        harness.call(),
      );
      const retried = await harness.comments.add(
        { target: onElement, text: 'uma vez', commentId: 'comment-once' },
        harness.call(),
      );

      assert.equal(retried.commentId, first.commentId);
      assert.equal(retried.text, 'uma vez');
      assert.equal(rowsOf(harness.log, 'comments.added/v1').length, 1);
      assert.equal((await harness.comments.list({}, harness.call())).length, 1);
    } finally {
      await harness.close();
    }
  });

  test('a retry after the comment was resolved returns it as it stands', async () => {
    const harness = await commentsHarness();

    try {
      await harness.comments.add(
        { target: onElement, text: 'resolvida', commentId: 'comment-done' },
        harness.call(),
      );
      await harness.comments.resolve(
        { commentId: 'comment-done', resolved: true },
        harness.call(),
      );

      const retried = await harness.comments.add(
        { target: onElement, text: 'resolvida', commentId: 'comment-done' },
        harness.call(),
      );

      assert.equal(retried.resolved, true);
      assert.equal(rowsOf(harness.log, 'comments.added/v1').length, 1);
    } finally {
      await harness.close();
    }
  });

  test('the same id in another Thread is a different comment', async () => {
    const harness = await commentsHarness();

    try {
      for (const scope of [promptScope, otherThread]) {
        await harness.comments.add(
          { target: onElement, text: 'nota', commentId: 'comment-same' },
          harness.call(scope),
        );
      }

      assert.equal(rowsOf(harness.log, 'comments.added/v1').length, 2);
    } finally {
      await harness.close();
    }
  });
});

describe('comments/v1.add replies', () => {
  test('a reply records the root it answers and keeps the target it was given', async () => {
    const harness = await commentsHarness();

    try {
      const root = await harness.comments.add(
        { target: onElement, text: 'raiz' },
        harness.call(),
      );
      const reply = await harness.comments.add(
        {
          target: onElement,
          text: 'resposta',
          author: 'agent',
          inReplyTo: root.commentId,
        },
        harness.call(),
      );

      assert.equal(reply.inReplyTo, root.commentId);
      assert.deepEqual(reply.target, onElement);

      const listed = await harness.comments.list({}, harness.call());

      assert.deepEqual(
        listed.map((comment) => [comment.text, comment.inReplyTo]),
        [
          ['raiz', undefined],
          ['resposta', root.commentId],
        ],
      );
      assert.equal(Object.hasOwn(listed[0] ?? {}, 'inReplyTo'), false);

      const payload = (rowsOf(harness.log, 'comments.added/v1')[1]?.event ??
        {}) as Record<string, unknown>;

      assert.equal(payload.inReplyTo, root.commentId);
    } finally {
      await harness.close();
    }
  });

  test('a reply to a reply is normalized to the root', async () => {
    const harness = await commentsHarness();

    try {
      const root = await harness.comments.add(
        { target: onElement, text: 'raiz' },
        harness.call(),
      );
      const reply = await harness.comments.add(
        { target: onElement, text: 'resposta', inReplyTo: root.commentId },
        harness.call(),
      );
      const deeper = await harness.comments.add(
        {
          target: onElement,
          text: 'resposta da resposta',
          inReplyTo: reply.commentId,
        },
        harness.call(),
      );

      assert.equal(deeper.inReplyTo, root.commentId);
    } finally {
      await harness.close();
    }
  });

  test('refuses a reply to a comment the Thread does not hold', async () => {
    const harness = await commentsHarness();

    try {
      const other = await harness.comments.add(
        { target: onElement, text: 'de outra conversa' },
        harness.call(otherThread),
      );

      for (const inReplyTo of ['comment-unknown', other.commentId]) {
        await assert.rejects(
          () =>
            harness.comments.add(
              { target: onElement, text: 'resposta', inReplyTo },
              harness.call(),
            ),
          codeOf('invalid_input'),
          inReplyTo,
        );
      }

      assert.equal(rowsOf(harness.log, 'comments.added/v1').length, 1);
    } finally {
      await harness.close();
    }
  });

  test('a flush can write a root and its reply in one batch, in that order', async () => {
    const harness = await commentsHarness();

    try {
      const batch = [
        { target: onElement, text: 'raiz', commentId: 'comment-root' },
        {
          target: onElement,
          text: 'resposta',
          commentId: 'comment-reply',
          inReplyTo: 'comment-root',
        },
      ];

      // The same flush, retried whole: nothing is written twice.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        for (const input of batch) {
          await harness.comments.add(input, harness.call());
        }
      }

      assert.deepEqual(
        (await harness.comments.list({}, harness.call())).map((comment) => [
          comment.commentId,
          comment.inReplyTo,
        ]),
        [
          ['comment-root', undefined],
          ['comment-reply', 'comment-root'],
        ],
      );
      assert.equal(rowsOf(harness.log, 'comments.added/v1').length, 2);
    } finally {
      await harness.close();
    }
  });

  test('resolving the root keeps the replies listed, folded like any comment', async () => {
    const harness = await commentsHarness();

    try {
      await harness.comments.add(
        { target: onElement, text: 'raiz', commentId: 'comment-root' },
        harness.call(),
      );
      await harness.comments.add(
        {
          target: onElement,
          text: 'resposta',
          inReplyTo: 'comment-root',
        },
        harness.call(),
      );
      await harness.comments.resolve(
        { commentId: 'comment-root', resolved: true },
        harness.call(),
      );

      const listed = await harness.comments.list({}, harness.call());

      assert.deepEqual(
        listed.map((comment) => [comment.text, comment.resolved]),
        [
          ['raiz', true],
          ['resposta', false],
        ],
      );
    } finally {
      await harness.close();
    }
  });
});

describe('comment_reply tool', () => {
  const rootInput = {
    target: onElement,
    text: 'aumenta o respiro',
    author: 'jao',
    commentId: 'comment-root',
  };

  test('is registered for the model at position 1800, always available', async () => {
    const harness = await commentsHarness();

    try {
      const entry = harness.registered.find(
        ({ tool }) => tool.name === 'comment_reply',
      );

      assert.deepEqual(entry?.options, { alwaysAvailable: true, order: 1800 });
    } finally {
      await harness.close();
    }
  });

  test('answers the comment as the agent, in its thread, leaving it open', async () => {
    const harness = await commentsHarness();

    try {
      await harness.comments.add(rootInput, harness.call());

      const result = (await harness.tool('comment_reply').execute({
        comment_id: 'comment-root',
        text: 'Aumentei o padding.',
      })) as {
        commentId: string;
        inReplyTo: string;
        resolved: boolean;
      };

      assert.equal(result.inReplyTo, 'comment-root');
      assert.equal(result.resolved, false);

      const listed = await harness.comments.list({}, harness.call());
      const reply = listed.find(
        ({ commentId }) => commentId === result.commentId,
      );

      assert.equal(reply?.author, 'agent');
      assert.equal(reply?.text, 'Aumentei o padding.');
      assert.equal(reply?.inReplyTo, 'comment-root');
      assert.deepEqual(reply?.target, onElement);
      assert.equal(
        listed.find(({ commentId }) => commentId === 'comment-root')?.resolved,
        false,
      );
      assert.equal(rowsOf(harness.log, 'comments.resolved/v1').length, 0);
    } finally {
      await harness.close();
    }
  });

  test('with resolve, also resolves the root comment', async () => {
    const harness = await commentsHarness();

    try {
      await harness.comments.add(rootInput, harness.call());

      const result = (await harness.tool('comment_reply').execute({
        comment_id: 'comment-root',
        text: 'Feito.',
        resolve: true,
      })) as { inReplyTo: string; resolved: boolean };

      assert.equal(result.inReplyTo, 'comment-root');
      assert.equal(result.resolved, true);

      const listed = await harness.comments.list({}, harness.call());

      assert.equal(
        listed.find(({ commentId }) => commentId === 'comment-root')?.resolved,
        true,
      );
      assert.equal(listed.length, 2);
    } finally {
      await harness.close();
    }
  });

  test('answering a reply lands in the same thread, under the root', async () => {
    const harness = await commentsHarness();

    try {
      await harness.comments.add(rootInput, harness.call());

      const first = (await harness
        .tool('comment_reply')
        .execute({ comment_id: 'comment-root', text: 'Qual botão?' })) as {
        commentId: string;
      };
      const second = (await harness.tool('comment_reply').execute({
        comment_id: first.commentId,
        text: 'Entendi.',
        resolve: true,
      })) as { inReplyTo: string; resolved: boolean };

      assert.equal(second.inReplyTo, 'comment-root');
      assert.equal(second.resolved, true);
    } finally {
      await harness.close();
    }
  });

  test('refuses an unknown comment id, also one of another Thread, and writes nothing', async () => {
    const harness = await commentsHarness();

    try {
      await harness.comments.add(rootInput, harness.call(otherThread));

      for (const comment_id of ['comment-unknown', 'comment-root']) {
        await assert.rejects(
          () =>
            harness
              .tool('comment_reply')
              .execute({ comment_id, text: 'resposta' }),
          (error: unknown) =>
            codeOf('invalid_input')(error) &&
            /unknown/u.test((error as Error).message),
          comment_id,
        );
      }

      assert.equal(rowsOf(harness.log, 'comments.added/v1').length, 1);
    } finally {
      await harness.close();
    }
  });
});
