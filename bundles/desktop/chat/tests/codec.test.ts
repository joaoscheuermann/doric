// C1–C3 (phase 3, S58): the wire edge of `chat`'s host part
// (`src/host/codec.ts`, D6). The state runs on the domain values of
// `src/contracts/index.ts`; the codec puts them on `chat.composer/v1`'s
// messages and reads them back. Each message it builds keeps its
// protovalidate rules; a write the wire cannot hold is answered as none.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  create,
  type DescMessage,
  type MessageShape,
} from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';
import { createValidator } from '@bufbuild/protovalidate';
import type { ContractError } from 'bundle/contracts';
import type { CommentAnchor } from 'comments/contracts';

import {
  AddItemRequestSchema,
  ComposerCommentWriteSchema,
  ComposerFlushContextSchema,
  ComposerItemSchema,
  WatchResponseSchema,
} from '../src/contracts/gen/doric/chat/composer/v1/composer_pb.js';
import type {
  ComposerCommentWrite,
  ComposerFlush,
  ComposerItem,
  ComposerWatchItem,
} from '../src/contracts/index.js';
import {
  addInputOf,
  commentWriteMessageOf,
  commentWriteOf,
  flushContextMessageOf,
  flushContextOf,
  itemMessageOf,
  itemOf,
  watchResponseOf,
  wireFlush,
} from '../src/host/codec.js';
import { itemJson, watchView } from './support/router.js';

const validator = createValidator();

const assertValid = <D extends DescMessage>(
  schema: D,
  message: MessageShape<D>,
): void => {
  const result = validator.validate(schema, message);
  assert.equal(result.kind, 'valid', JSON.stringify(result));
};

/** A domain item; `data` is always a key (`undefined` when absent), `author` only when given. */
const item = (data: unknown, author?: string): ComposerItem => ({
  id: 'comment-a',
  kind: 'message',
  elementTag: 'chat-comment-line',
  data,
  ...(author === undefined ? {} : { author }),
  note: 'the note',
});

/** Every field an anchor may carry, on any form. */
const fields = {
  path: 'src/app.tsx',
  line: 4,
  selector: 'main > h1',
  x: 12.5,
  y: 40,
  label: 'h1',
  text: 'the words',
  pseudo: '::before',
  turn: 'turn-1',
  block: 2,
  at: 3,
  item: 1,
} as const;

const writeOf = (anchor: CommentAnchor): ComposerCommentWrite => ({
  target: { kind: 'preview', id: 'program-1', revision: 7, anchor },
  text: 'a comment',
  author: 'ana',
  commentId: 'comment-a',
  inReplyTo: 'comment-root',
});

const errorView = (error: unknown) => {
  const { code, message } = error as ContractError;
  return { code, message };
};

describe('C1: items', () => {
  const cases: [string, ComposerItem][] = [
    [
      'an object',
      item({ target: { kind: 'message', nested: [1, 'two', true, null] } }),
    ],
    ['null', item(null)],
    ['a string', item('a string')],
    ['a number', item(42.5)],
    ['no data', item(undefined)],
    ['an author', item({ a: 1 }, 'ana')],
  ];

  for (const [name, domain] of cases) {
    void test(`C1: itemOf(itemMessageOf(x)) is x for ${name}, and the message keeps protovalidate`, () => {
      const message = create(ComposerItemSchema, itemMessageOf(domain));
      assertValid(ComposerItemSchema, message);
      assert.deepEqual(itemOf(message), domain);
    });
  }

  void test('C1: the data travels as the Value of the same JSON, an absent data as no Value', () => {
    const message = create(
      ComposerItemSchema,
      itemMessageOf(item({ a: [1, 'b'] }, 'ana')),
    );
    assert.deepEqual(itemJson(message), {
      id: 'comment-a',
      kind: 'message',
      elementTag: 'chat-comment-line',
      data: { a: [1, 'b'] },
      author: 'ana',
      note: 'the note',
    });
    assert.equal(
      create(ComposerItemSchema, itemMessageOf(item(undefined))).data,
      undefined,
    );
  });
});

describe('C2: comment writes', () => {
  for (const form of ['source', 'selector', 'point', 'range'] as const) {
    void test(`C2: commentWriteOf(commentWriteMessageOf(w)) is w for a ${form} anchor with every field`, () => {
      const write = writeOf({ form, ...fields });
      const init =
        commentWriteMessageOf(write) ?? assert.fail('not expressible');
      const message = create(ComposerCommentWriteSchema, init);
      assertValid(ComposerCommentWriteSchema, message);
      assert.equal(message.target?.anchor?.form.case, form);
      assert.deepEqual(commentWriteOf(message), write);
    });
  }

  void test('C2: a write without revision, author, comment id or root keeps none of them', () => {
    const write: ComposerCommentWrite = {
      target: {
        kind: 'message',
        id: 'p',
        anchor: { form: 'range', text: 't' },
      },
      text: 'hi',
    };
    const message = create(
      ComposerCommentWriteSchema,
      commentWriteMessageOf(write) ?? assert.fail('not expressible'),
    );
    assert.deepEqual(commentWriteOf(message), write);
  });

  void test('C2: an anchor form or a pseudo the wire cannot hold is no message, and wireFlush answers no write for it', async () => {
    const circle = writeOf({
      form: 'circle',
      text: 'x',
    } as unknown as CommentAnchor);
    const marker = writeOf({
      form: 'range',
      text: 'x',
      pseudo: '::marker',
    } as unknown as CommentAnchor);
    assert.equal(commentWriteMessageOf(circle), undefined);
    assert.equal(commentWriteMessageOf(marker), undefined);

    const answering =
      (writes: ComposerCommentWrite[]): ComposerFlush =>
      () =>
        Promise.resolve(writes);
    const context = { threadId: 't', promptId: 'p' };
    const good = writeOf({ form: 'point', x: 1, y: 2 });
    assert.deepEqual(
      await wireFlush(answering([good, circle]))(item({}), context),
      [],
    );
    assert.deepEqual(await wireFlush(answering([good]))(item({}), context), [
      good,
    ]);
    const failure = new Error('the flush failed');
    await assert.rejects(
      wireFlush(() => Promise.reject(failure))(item({}), context),
      (error) => error === failure,
    );
  });

  void test('C2: a wire write without target or without anchor case is invalid_output', () => {
    const expected = {
      code: 'invalid_output',
      message: 'A flush answered a comment write without a target.',
    };
    assert.throws(
      () => commentWriteOf(create(ComposerCommentWriteSchema, { text: 'x' })),
      (error) => {
        assert.deepEqual(errorView(error), expected);
        return true;
      },
    );
    assert.throws(
      () =>
        commentWriteOf(
          create(ComposerCommentWriteSchema, {
            target: { kind: 'message', id: 'p', anchor: {} },
            text: 'x',
          }),
        ),
      (error) => {
        assert.deepEqual(errorView(error), expected);
        return true;
      },
    );
  });
});

describe('C3: watch items, AddItem input and the flush context', () => {
  const one: ComposerItem = item({ a: 1 }, 'ana');
  const cases: [ComposerWatchItem, Record<string, unknown>][] = [
    [
      { kind: 'snapshot', threadId: 't', text: 'words', items: [one] },
      {
        revision: 0,
        kind: 'snapshot',
        threadId: 't',
        text: 'words',
        items: [
          {
            id: 'comment-a',
            kind: 'message',
            elementTag: 'chat-comment-line',
            data: { a: 1 },
            author: 'ana',
            note: 'the note',
          },
        ],
      },
    ],
    [
      { kind: 'text', threadId: 't', text: 'words' },
      { revision: 3, kind: 'text', threadId: 't', text: 'words' },
    ],
    [
      { kind: 'added', threadId: 't', item: one },
      {
        revision: 4,
        kind: 'added',
        threadId: 't',
        item: {
          id: 'comment-a',
          kind: 'message',
          elementTag: 'chat-comment-line',
          data: { a: 1 },
          author: 'ana',
          note: 'the note',
        },
      },
    ],
    [
      { kind: 'updated', threadId: 't', item: { ...one, note: 'm' } },
      {
        revision: 5,
        kind: 'updated',
        threadId: 't',
        item: {
          id: 'comment-a',
          kind: 'message',
          elementTag: 'chat-comment-line',
          data: { a: 1 },
          author: 'ana',
          note: 'm',
        },
      },
    ],
    [
      { kind: 'removed', threadId: 't', id: 'comment-a' },
      { revision: 6, kind: 'removed', threadId: 't', id: 'comment-a' },
    ],
  ];

  for (const [domain, expected] of cases) {
    void test(`C3: watchResponseOf of a ${domain.kind} item is its oneof case with the revision`, () => {
      const message = create(
        WatchResponseSchema,
        watchResponseOf(domain, expected.revision as number),
      );
      assertValid(WatchResponseSchema, message);
      assert.deepEqual(watchView(message), expected);
    });
  }

  void test('C3: addInputOf drops the optional fields the request leaves out', () => {
    assert.deepEqual(
      addInputOf(
        create(AddItemRequestSchema, {
          threadId: 't',
          kind: 'message',
          elementTag: 'chat-comment-line',
        }),
      ),
      { threadId: 't', kind: 'message', elementTag: 'chat-comment-line' },
    );
    assert.deepEqual(
      addInputOf(
        create(AddItemRequestSchema, {
          threadId: 't',
          id: 'comment-x',
          kind: 'message',
          elementTag: 'chat-comment-line',
          data: create(ValueSchema, { kind: { case: 'nullValue', value: 0 } }),
          author: 'ana',
          note: 'n',
        }),
      ),
      {
        threadId: 't',
        id: 'comment-x',
        kind: 'message',
        elementTag: 'chat-comment-line',
        data: null,
        author: 'ana',
        note: 'n',
      },
    );
  });

  void test('C3: the flush context goes on the wire and back, projectId absent when undefined', () => {
    for (const context of [
      { threadId: 't', promptId: 'p' },
      { projectId: 'project-1', threadId: 't', promptId: 'p' },
    ]) {
      const message = create(
        ComposerFlushContextSchema,
        flushContextMessageOf(context),
      );
      assertValid(ComposerFlushContextSchema, message);
      assert.deepEqual(flushContextOf(message), context);
    }
  });
});
