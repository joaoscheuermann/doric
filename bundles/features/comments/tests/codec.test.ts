// `comments/v1` messages ⇄ today's domain values (phase 3, S52a, C21, D3):
// the anchor's oneof case is today's `form` with the case message's fields
// beside it, an absent optional field is an absent key, and unknown keys of a
// loose domain value are dropped on the way to a message.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  create,
  equals,
  type MessageInitShape,
  toJson,
} from '@bufbuild/protobuf';
import { isContractError } from 'bundle/contracts';

import {
  AddRequestSchema,
  type CommentAnchorSchema,
  CommentSchema,
  CommentTargetSchema,
} from '../src/contracts/gen/doric/comments/v1/comments_pb.js';
import type { Comment, CommentAnchor } from '../src/contracts/index.js';
import {
  addedMessageOf,
  addInputOf,
  commentMessageOf,
} from '../src/host/codec.js';

/** Each anchor form: the wire init and today's flat anchor. */
const forms: readonly {
  readonly wire: MessageInitShape<typeof CommentAnchorSchema>;
  readonly flat: CommentAnchor;
}[] = [
  {
    wire: { form: { case: 'source', value: { path: 'src/a.tsx' } } },
    flat: { form: 'source', path: 'src/a.tsx' },
  },
  {
    wire: { form: { case: 'source', value: { path: 'src/a.tsx', line: 42 } } },
    flat: { form: 'source', path: 'src/a.tsx', line: 42 },
  },
  {
    wire: {
      form: {
        case: 'source',
        value: { path: 'src/a.tsx', line: 3, pseudo: '::after' },
      },
    },
    flat: { form: 'source', path: 'src/a.tsx', line: 3, pseudo: '::after' },
  },
  {
    wire: { form: { case: 'selector', value: { selector: 'main > button' } } },
    flat: { form: 'selector', selector: 'main > button' },
  },
  {
    wire: { form: { case: 'point', value: { x: 412, y: 180, label: 'ul' } } },
    flat: { form: 'point', x: 412, y: 180, label: 'ul' },
  },
  {
    wire: {
      form: {
        case: 'range',
        value: {
          text: 'essa resposta',
          turn: 'agent:p:3',
          block: 2,
          at: 0,
          item: 1,
        },
      },
    },
    flat: {
      form: 'range',
      text: 'essa resposta',
      turn: 'agent:p:3',
      block: 2,
      at: 0,
      item: 1,
    },
  },
];

describe('comments/v1 codec', () => {
  test('C21: each form round-trips addInputOf → domain → addedMessageOf', () => {
    for (const { wire, flat } of forms) {
      const request = create(AddRequestSchema, {
        target: {
          kind: 'artifact',
          id: 'checkout-7f3a',
          revision: 1,
          anchor: wire,
        },
        text: 'nota',
        author: 'jao',
        commentId: 'comment-1',
        inReplyTo: 'comment-0',
      });
      const input = addInputOf(request);

      assert.deepEqual(
        input,
        {
          target: {
            kind: 'artifact',
            id: 'checkout-7f3a',
            revision: 1,
            anchor: flat,
          },
          text: 'nota',
          author: 'jao',
          commentId: 'comment-1',
          inReplyTo: 'comment-0',
        },
        flat.form,
      );

      const message = addedMessageOf({
        commentId: 'comment-1',
        target: input.target,
        text: input.text,
        createdAt: '2026-11-23T12:00:00.000Z',
      });

      assert.ok(message.target !== undefined, flat.form);
      assert.ok(request.target !== undefined);
      assert.ok(
        equals(CommentTargetSchema, message.target, request.target),
        JSON.stringify(toJson(CommentTargetSchema, message.target)),
      );
      assert.equal(message.commentId, 'comment-1');
      assert.equal(message.createdAt, '2026-11-23T12:00:00.000Z');
    }
  });

  test('C21: an AddRequest without author, id and reply leaves those keys absent', () => {
    const input = addInputOf(
      create(AddRequestSchema, {
        target: { kind: 'message', id: 'prompt-1', anchor: forms[0]?.wire },
        text: 'nota',
      }),
    );

    assert.deepEqual(input, {
      target: { kind: 'message', id: 'prompt-1', anchor: forms[0]?.flat },
      text: 'nota',
    });
  });

  test('C21: commentMessageOf of a comment from a loose row drops the keys the message does not declare', () => {
    const loose = {
      commentId: 'comment-1',
      target: {
        kind: 'artifact',
        id: 'checkout-7f3a',
        anchor: { form: 'source', path: 'src/a.tsx', extraAnchor: 1 },
        extraTarget: 'x',
      },
      text: 'nota',
      resolved: false,
      createdAt: '2026-11-23T12:00:00.000Z',
      extra: true,
    } as unknown as Comment;

    assert.deepEqual(
      toJson(CommentSchema, commentMessageOf(loose), {
        alwaysEmitImplicit: true,
      }),
      {
        commentId: 'comment-1',
        target: {
          kind: 'artifact',
          id: 'checkout-7f3a',
          anchor: { source: { path: 'src/a.tsx' } },
        },
        text: 'nota',
        resolved: false,
        createdAt: '2026-11-23T12:00:00.000Z',
      },
    );
  });

  test('C21: a comment whose revision is not a whole number fails invalid_output', () => {
    const comment: Comment = {
      commentId: 'comment-1',
      target: {
        kind: 'artifact',
        id: 'checkout-7f3a',
        revision: 1.5,
        anchor: { form: 'source', path: 'src/a.tsx' },
      },
      text: 'nota',
      resolved: true,
      createdAt: '2026-11-23T12:00:00.000Z',
    };

    assert.throws(
      () => commentMessageOf(comment),
      (error: unknown) =>
        isContractError(error) && error.code === 'invalid_output',
    );
  });
});
