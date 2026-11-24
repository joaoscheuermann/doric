// The wire edge of `chat`'s host part (phase 3, S58, D6): the state runs on
// the domain values of `src/contracts/index.ts`; these functions convert them
// to and from `chat.composer/v1`'s messages.

import {
  fromJson,
  type JsonValue,
  type MessageInitShape,
  toJson,
} from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';
import { ContractError } from 'bundle/contracts';
import type { CommentAnchor, CommentTarget } from 'comments/contracts';
import type {
  CommentAnchorFieldsSchema,
  CommentTarget as CommentTargetMessage,
  CommentTargetSchema,
} from 'comments/contracts/gen/doric/comments/v1/comments_pb.js';

import type {
  AddItemRequest,
  ComposerCommentWrite as ComposerCommentWriteMessage,
  ComposerCommentWriteSchema,
  ComposerFlushContext as ComposerFlushContextMessage,
  ComposerFlushContextSchema,
  ComposerFlushedSchema,
  ComposerItem as ComposerItemMessage,
  ComposerItemSchema,
  ComposerSnapshotSchema,
  WatchResponseSchema,
} from '../contracts/gen/doric/chat/composer/v1/composer_pb.js';
import type {
  ComposerAddInput,
  ComposerCommentWrite,
  ComposerFlush,
  ComposerFlushContext,
  ComposerFlushed,
  ComposerItem,
  ComposerSnapshot,
  ComposerWatchItem,
} from '../contracts/index.js';

/** A record without the keys whose value is `undefined`: absent means absent. */
const definedFields = <T extends object>(value: T): T =>
  Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;

const FORMS: ReadonlySet<string> = new Set([
  'source',
  'selector',
  'point',
  'range',
]);

const isForm = (value: string): value is CommentAnchor['form'] =>
  FORMS.has(value);

const isPseudo = (
  value: string,
): value is NonNullable<CommentAnchor['pseudo']> =>
  value === '::before' || value === '::after';

/** A wire item as the state holds it: `data` as JSON, absent → `undefined`; `author` absent → no key. Pure. */
export const itemOf = (message: ComposerItemMessage): ComposerItem => ({
  id: message.id,
  kind: message.kind,
  elementTag: message.elementTag,
  data:
    message.data === undefined ? undefined : toJson(ValueSchema, message.data),
  ...(message.author === undefined ? {} : { author: message.author }),
  note: message.note,
});

/** The state's item on the wire: `data` `undefined` → absent, else `fromJson(ValueSchema, data)`. Pure. */
export const itemMessageOf = (
  item: ComposerItem,
): MessageInitShape<typeof ComposerItemSchema> =>
  definedFields({
    id: item.id,
    kind: item.kind,
    elementTag: item.elementTag,
    data:
      item.data === undefined
        ? undefined
        : fromJson(ValueSchema, item.data as JsonValue),
    author: item.author,
    note: item.note,
  });

/** `AddItem`'s request as the state's input (absent `id`, `data`, `author`, `note` → no key). Pure. */
export const addInputOf = (request: AddItemRequest): ComposerAddInput =>
  definedFields({
    threadId: request.threadId,
    id: request.id,
    kind: request.kind,
    elementTag: request.elementTag,
    data:
      request.data === undefined
        ? undefined
        : toJson(ValueSchema, request.data),
    author: request.author,
    note: request.note,
  });

/** A snapshot on the wire, items through `itemMessageOf`. Pure. */
export const snapshotMessageOf = (
  snapshot: ComposerSnapshot,
): MessageInitShape<typeof ComposerSnapshotSchema> => ({
  threadId: snapshot.threadId,
  text: snapshot.text,
  items: snapshot.items.map(itemMessageOf),
});

/**
 * One watch item with its revision: `snapshot` → `kind.case 'snapshot'`; `text` → `ComposerTextDelta`; `added`,
 * `updated` → `ComposerItemDelta`; `removed` → `ComposerRemovedDelta`. Pure.
 */
export const watchResponseOf = (
  item: ComposerWatchItem,
  revision: number,
): MessageInitShape<typeof WatchResponseSchema> => {
  switch (item.kind) {
    case 'snapshot':
      return {
        revision,
        kind: { case: 'snapshot', value: snapshotMessageOf(item) },
      };
    case 'text':
      return {
        revision,
        kind: {
          case: 'text',
          value: { threadId: item.threadId, text: item.text },
        },
      };
    case 'added':
    case 'updated':
      return {
        revision,
        kind: {
          case: item.kind,
          value: { threadId: item.threadId, item: itemMessageOf(item.item) },
        },
      };
    case 'removed':
      return {
        revision,
        kind: {
          case: 'removed',
          value: { threadId: item.threadId, id: item.id },
        },
      };
  }
};

/** The flush context on the wire (`projectId` absent when `undefined`), and back. Pure. */
export const flushContextMessageOf = (
  context: ComposerFlushContext,
): MessageInitShape<typeof ComposerFlushContextSchema> =>
  definedFields({
    projectId: context.projectId,
    threadId: context.threadId,
    promptId: context.promptId,
  });

export const flushContextOf = (
  message: ComposerFlushContextMessage,
): ComposerFlushContext =>
  definedFields({
    projectId: message.projectId,
    threadId: message.threadId,
    promptId: message.promptId,
  });

/** A domain target on the wire, or `undefined` when its anchor's `form` or `pseudo` has no wire form. */
const targetMessageOf = (
  target: CommentTarget,
): MessageInitShape<typeof CommentTargetSchema> | undefined => {
  const {
    form,
    path,
    line,
    selector,
    x,
    y,
    label,
    text,
    pseudo,
    turn,
    block,
    at,
    item,
  } = target.anchor;

  if (!isForm(form) || (pseudo !== undefined && !isPseudo(pseudo))) {
    return undefined;
  }

  const value: MessageInitShape<typeof CommentAnchorFieldsSchema> =
    definedFields({
      path,
      line,
      selector,
      x,
      y,
      label,
      text,
      pseudo,
      turn,
      block,
      at,
      item,
    });

  return definedFields({
    kind: target.kind,
    id: target.id,
    revision: target.revision,
    anchor: { form: { case: form, value } },
  });
};

/** A wire target as the domain's; throws `invalid_output` without target or anchor case. */
const targetOf = (target: CommentTargetMessage | undefined): CommentTarget => {
  const form = target?.anchor?.form;

  if (target === undefined || form?.case === undefined) {
    throw new ContractError(
      'invalid_output',
      'A flush answered a comment write without a target.',
    );
  }

  const {
    path,
    line,
    selector,
    x,
    y,
    label,
    text,
    pseudo,
    turn,
    block,
    at,
    item,
  } = form.value;

  if (pseudo !== undefined && !isPseudo(pseudo)) {
    throw new ContractError(
      'invalid_output',
      `A flush answered a comment anchor whose pseudo is "${pseudo}".`,
    );
  }

  return definedFields({
    kind: target.kind,
    id: target.id,
    revision: target.revision,
    anchor: definedFields({
      form: form.case,
      path,
      line,
      selector,
      x,
      y,
      label,
      text,
      pseudo,
      turn,
      block,
      at,
      item,
    }),
  });
};

/**
 * A domain write on the wire: the anchor's `form` becomes the `oneof` case, its fields the case message's (only the
 * declared ones); `undefined` when the target cannot be expressed (an anchor `form` outside `source`, `selector`,
 * `point`, `range`, or a `pseudo` outside `::before`/`::after`). Pure; never throws.
 */
export const commentWriteMessageOf = (
  write: ComposerCommentWrite,
): MessageInitShape<typeof ComposerCommentWriteSchema> | undefined => {
  const target = targetMessageOf(write.target);

  if (target === undefined) {
    return undefined;
  }

  return definedFields({
    target,
    text: write.text,
    author: write.author,
    commentId: write.commentId,
    inReplyTo: write.inReplyTo,
  });
};

/**
 * A wire write as a domain write (the inverse of `commentWriteMessageOf` on expressible writes). Throws
 * `ContractError('invalid_output', 'A flush answered a comment write without a target.')` when `target` or its
 * anchor case is absent.
 */
export const commentWriteOf = (
  message: ComposerCommentWriteMessage,
): ComposerCommentWrite =>
  definedFields({
    target: targetOf(message.target),
    text: message.text,
    author: message.author,
    commentId: message.commentId,
    inReplyTo: message.inReplyTo,
  });

/** One flushed item on the wire; every write is expressible by construction (see `wireFlush`). Pure. */
export const flushedMessageOf = (
  flushed: ComposerFlushed,
): MessageInitShape<typeof ComposerFlushedSchema> => ({
  item: itemMessageOf(flushed.item),
  writes: flushed.writes.flatMap((write) => commentWriteMessageOf(write) ?? []),
});

/**
 * `flush` restricted to what the wire holds: its writes when each is expressible (`commentWriteMessageOf`), else
 * `[]` (the item stays drafted, D5). Rejects as `flush` does.
 */
export const wireFlush =
  (flush: ComposerFlush): ComposerFlush =>
  async (item, context) => {
    const writes = await flush(item, context);

    return writes.every((write) => commentWriteMessageOf(write) !== undefined)
      ? writes
      : [];
  };
