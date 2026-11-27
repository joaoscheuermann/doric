// `comments`' host part through the router (phase 3, S52a, C1–C17; S68a's
// ported cases P1–P8 carry what the deleted kernel suite covered alone):
// `comments/v1` and the `comment_reply` tool over `events/v1`,
// `runtime.threads/v1` and `tools/v1`, as `src/host/main.ts` serves them. The
// fakes store an appended row as `core` does (the message's JSON, fields at
// their default left out), so every read below goes through finding F1's
// encoding; C12 also reads rows in the kernel's 1.x encoding.

import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import {
  fromJson,
  type JsonObject,
  type JsonValue,
  type MessageInitShape,
  toJson,
} from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';
import { ConnectError } from '@connectrpc/connect';
import {
  type CallScope,
  ContractError,
  fromConnectError,
  isContractError,
} from 'bundle/contracts';
import type { ThreadEvent } from 'runtime/contracts';

import {
  type Comment as CommentMessage,
  CommentSchema,
  type CommentTargetSchema,
} from '../src/contracts/gen/doric/comments/v1/comments_pb.js';
import type { CommentTarget } from '../src/contracts/index.js';
import { tool } from '../src/host/tools/comment-reply.js';
import {
  type Harness,
  harness,
  promptScope,
  type ThreadLog,
  threadLog,
} from './support/router.js';

const otherThread: CallScope = { ...promptScope, threadId: 'thread-2' };
const otherProject: CallScope = { ...promptScope, projectId: 'project-2' };
const projectScope: CallScope = { projectId: 'project-1' };

const onElement: CommentTarget = {
  kind: 'artifact',
  id: 'checkout-7f3a',
  revision: 1,
  anchor: { form: 'source', path: 'src/checkout/Checkout.tsx', line: 42 },
};

const onSpace: CommentTarget = {
  kind: 'artifact',
  id: 'checkout-7f3a',
  revision: 1,
  anchor: { form: 'point', x: 412, y: 180, label: 'ul' },
};

const onSecondRevision: CommentTarget = {
  kind: 'artifact',
  id: 'checkout-7f3a',
  revision: 2,
  anchor: { form: 'source', path: 'src/checkout/Checkout.tsx', line: 42 },
};

const onMessage: CommentTarget = {
  kind: 'message',
  id: 'prompt-1',
  anchor: { form: 'range', text: 'essa resposta', turn: 'agent:p:3', block: 2 },
};

/** Each anchor form C4 writes. */
const everyForm: readonly CommentTarget[] = [
  onElement,
  {
    kind: 'artifact',
    id: 'checkout-7f3a',
    anchor: { form: 'source', path: 'src/checkout/Checkout.tsx' },
  },
  {
    kind: 'artifact',
    id: 'checkout-7f3a',
    revision: 2,
    anchor: { form: 'selector', selector: 'main > button', label: 'button' },
  },
  onSpace,
  {
    kind: 'message',
    id: 'prompt-1',
    anchor: {
      form: 'range',
      text: 'essa resposta',
      turn: 'agent:p:3',
      block: 2,
      at: 5,
      item: 0,
    },
  },
  {
    kind: 'artifact',
    id: 'checkout-7f3a',
    revision: 1,
    anchor: { form: 'source', path: 'src/a.tsx', line: 3, pseudo: '::before' },
  },
];

const GENERATED_ID = /^comment-[0-9a-f-]{36}$/u;

const UNKNOWN_COMMENT = (id: string) =>
  `The comment "${id}" is unknown in this conversation; use an id the prompt names.`;

// ---------------------------------------------------------------------------
// Wire ⇄ domain, as D3 states it: the anchor's oneof case is today's `form`
// and the case message's fields sit beside it.

/** A domain target as the wire init of `CommentTarget`. */
const wireTarget = (
  target: CommentTarget,
): MessageInitShape<typeof CommentTargetSchema> => {
  const { form, ...fields } = target.anchor;

  return {
    kind: target.kind,
    id: target.id,
    ...(target.revision === undefined ? {} : { revision: target.revision }),
    anchor: { form: { case: form, value: fields } },
  } as MessageInitShape<typeof CommentTargetSchema>;
};

/** A domain target as the message's JSON (the anchor nested by its case). */
const nestedTarget = (target: CommentTarget): JsonObject => {
  const { form, ...fields } = target.anchor;

  return {
    kind: target.kind,
    id: target.id,
    ...(target.revision === undefined ? {} : { revision: target.revision }),
    anchor: { [form]: fields },
  };
};

/** A wire `Comment` as domain JSON: implicit fields kept, the anchor flat. */
const domainOf = (comment: CommentMessage | undefined): JsonValue => {
  if (comment === undefined) return null;

  const json = toJson(CommentSchema, comment, {
    alwaysEmitImplicit: true,
  }) as JsonObject;
  const target = json.target as JsonObject;
  const [[form, fields]] = Object.entries(target.anchor as JsonObject) as [
    [string, JsonObject],
  ];

  return { ...json, target: { ...target, anchor: { form, ...fields } } };
};

/** A domain value as plain JSON, absent keys left out. */
const plain = (value: unknown): JsonValue =>
  value === undefined ? null : (JSON.parse(JSON.stringify(value)) as JsonValue);

// ---------------------------------------------------------------------------
// Errors.

/** The Doric error of a failure: a `ContractError`, or read off a `ConnectError`. */
const contractErrorOf = (error: unknown): ContractError => {
  if (error instanceof ConnectError) return fromConnectError(error);

  assert.ok(isContractError(error), `expected a Doric error: ${error}`);

  return error;
};

/** The Doric error `promise` rejects with; fails the test when it resolves. */
const rejectionOf = async (
  promise: Promise<unknown>,
): Promise<ContractError> => {
  try {
    await promise;
  } catch (error) {
    return contractErrorOf(error);
  }

  return assert.fail('the call succeeded');
};

const codeOf = async (promise: Promise<unknown>): Promise<string> =>
  (await rejectionOf(promise)).code;

// ---------------------------------------------------------------------------
// Harness.

/** The part on a test router over `log`, activated, stopped when the test ends. */
const activated = async (
  t: TestContext,
  log: ThreadLog = threadLog(),
): Promise<Harness> => {
  const h = harness(log);

  t.after(() => h.router.control.stop());
  await h.activate();

  return h;
};

/** `Execute{name: comment_reply, payload}`'s result as JSON. */
const reply = async (
  h: Harness,
  payload: JsonValue,
  scope?: CallScope,
): Promise<JsonValue> => {
  const { result } = await h.tools(scope).execute({
    name: 'comment_reply',
    payload: fromJson(ValueSchema, payload),
  });

  return result === undefined ? null : toJson(ValueSchema, result);
};

/** The comments `List` answers for `input` under `scope`, as domain JSON. */
const listed = async (
  h: Harness,
  input: Parameters<ReturnType<Harness['comments']>['list']>[0] = {},
  scope?: CallScope,
): Promise<JsonValue[]> =>
  (await h.comments(scope).list(input)).comments.map(domainOf);

/** A stored row of `scope`'s Thread. */
const row = (
  sequence: number,
  type: string,
  event: JsonObject,
  scope: CallScope = promptScope,
): ThreadEvent => ({
  projectId: scope.projectId ?? '',
  threadId: scope.threadId ?? '',
  promptId: scope.promptId ?? '',
  sequence,
  type,
  event,
  createdAt: '2026-11-20T10:00:00.000Z',
});

/** A log holding `rows`. */
const logOf = (rows: readonly ThreadEvent[]): ThreadLog => ({
  rows: rows.map((entry) => structuredClone(entry)),
});

// ---------------------------------------------------------------------------
// C1–C3: activation.

void test('C1: activate registers both events, then comment_reply at 1800, and sends no Sink', async (t) => {
  const h = await activated(t);

  assert.deepEqual(
    h.eventRegisters.map(({ request }) => request),
    [
      {
        type: 'comments.added/v1',
        messageType: 'doric.comments.added.v1.CommentsAdded',
      },
      {
        type: 'comments.resolved/v1',
        messageType: 'doric.comments.resolved.v1.CommentsResolved',
      },
    ],
  );
  assert.deepEqual(h.sinks, []);
  assert.deepEqual(
    h.toolRegisters.map(({ request }) => request),
    [
      {
        tool: {
          name: 'comment_reply',
          ...(tool.description === undefined
            ? {}
            : { description: tool.description }),
          definition: {
            name: 'comment_reply',
            ...(tool.definition.description === undefined
              ? {}
              : { description: tool.definition.description }),
            inputSchema: JSON.stringify(tool.definition.inputSchema),
            outputSchema: JSON.stringify(tool.definition.outputSchema),
            ...(tool.definition.strict === undefined
              ? {}
              : { strict: tool.definition.strict }),
          },
        },
        options: { alwaysAvailable: true, order: 1800 },
      },
    ],
  );
  assert.deepEqual(h.timeline, [
    'events.register:comments.added/v1',
    'events.register:comments.resolved/v1',
    'tools.register:comment_reply',
  ]);
});

void test('C2: a refused event Register fails activate with its code and Add stays unavailable; a refused tool Register fails it too and comment_reply is not served', async (t) => {
  const events = harness();

  t.after(() => events.router.control.stop());
  events.failures.registerEvent = {
    type: 'comments.added/v1',
    error: new ContractError('registration_conflict', 'taken'),
  };

  assert.equal(await codeOf(events.activate()), 'registration_conflict');
  assert.equal(
    await codeOf(
      events.comments().add({ target: wireTarget(onElement), text: 'nota' }),
    ),
    'unavailable',
  );
  assert.deepEqual(events.appends, []);

  const tools = harness();

  t.after(() => tools.router.control.stop());
  tools.failures.registerTool = new ContractError('duplicate_tool', 'taken');

  assert.equal(await codeOf(tools.activate()), 'duplicate_tool');
  assert.equal(
    await codeOf(reply(tools, { comment_id: 'comment-1', text: 'ok' })),
    'not_found',
  );
});

void test('C3: before activate, Add, List and Resolve answer unavailable', async (t) => {
  const h = harness();

  t.after(() => h.router.control.stop());
  await h.serveWithoutActivate();

  const client = h.comments();

  assert.equal(
    await codeOf(client.add({ target: wireTarget(onElement), text: 'nota' })),
    'unavailable',
  );
  assert.equal(await codeOf(client.list({})), 'unavailable');
  assert.equal(
    await codeOf(client.resolve({ commentId: 'comment-1', resolved: true })),
    'unavailable',
  );
  assert.deepEqual(h.timeline, []);
});

// ---------------------------------------------------------------------------
// C4–C9: Add.

void test('C4: Add writes one CommentsAdded per form, the anchor under its case, and answers the comment', async (t) => {
  const h = await activated(t);

  for (const [index, target] of everyForm.entries()) {
    const author = index === 0 ? { author: 'jao' } : {};
    const { comment } = await h.comments().add({
      target: wireTarget(target),
      text: '  nota  ',
      ...author,
    });
    const answer = domainOf(comment) as JsonObject;
    const commentId = answer.commentId as string;
    const createdAt = answer.createdAt as string;

    assert.match(commentId, GENERATED_ID);
    assert.equal(new Date(createdAt).toISOString(), createdAt);
    assert.deepEqual(answer, {
      commentId,
      target: plain(target),
      text: 'nota',
      ...author,
      resolved: false,
      createdAt,
    });

    const appended = h.appends[index];

    assert.equal(h.appends.length, index + 1);
    assert.equal(appended?.request.type, 'comments.added/v1');
    assert.deepEqual(appended?.scope, promptScope);
    assert.deepEqual(
      appended?.request.payload,
      {
        commentId,
        target: nestedTarget(target),
        text: 'nota',
        ...author,
        createdAt,
      },
      target.anchor.form,
    );
  }
});

void test('C5: Add without a prompt (or without a Thread) is invalid_scope and reads and writes nothing', async (t) => {
  const h = await activated(t);
  const target = wireTarget(onElement);

  assert.equal(
    await codeOf(
      h.comments({ projectId: 'project-1', threadId: 'thread-1' }).add({
        target,
        text: 'nota',
        commentId: 'comment-1',
      }),
    ),
    'invalid_scope',
  );
  assert.equal(
    await codeOf(h.comments(projectScope).add({ target, text: 'nota' })),
    'invalid_scope',
  );
  assert.deepEqual(h.appends, []);
  assert.deepEqual(h.threadEvents, []);
});

void test('C6: blank text and a malformed seat are invalid_input, as the kernel refuses them', async (t) => {
  const h = await activated(t);

  assert.equal(
    await codeOf(
      h.comments().add({ target: wireTarget(onElement), text: '   ' }),
    ),
    'invalid_input',
  );

  for (const anchor of [
    { form: 'range', text: 'essa resposta', block: 1 },
    { form: 'range', text: 'essa resposta', turn: 'agent:p:3', block: 1.5 },
    { form: 'range', text: 'essa resposta', turn: 'agent:p:3', at: 3 },
  ] as const) {
    assert.equal(
      await codeOf(
        h.comments().add({
          target: wireTarget({ kind: 'message', id: 'prompt-1', anchor }),
          text: 'nota',
        }),
      ),
      'invalid_input',
      JSON.stringify(anchor),
    );
  }

  assert.deepEqual(h.appends, []);
});

void test('C7: protovalidate refuses a request before the handler: no form, a source without path, line 0, a pseudo outside the list, a malformed id', async (t) => {
  const h = await activated(t);
  const base = { kind: 'artifact', id: 'checkout-7f3a' };
  const requests = [
    { target: { ...base, anchor: {} }, text: 'nota' },
    {
      target: {
        ...base,
        anchor: { form: { case: 'source', value: { line: 3 } } },
      },
      text: 'nota',
    },
    {
      target: {
        ...base,
        anchor: { form: { case: 'source', value: { path: 'a.ts', line: 0 } } },
      },
      text: 'nota',
    },
    {
      target: {
        ...base,
        anchor: {
          form: {
            case: 'source',
            value: { path: 'a.ts', pseudo: '::marker' },
          },
        },
      },
      text: 'nota',
    },
    { target: wireTarget(onElement), text: 'nota', commentId: 'a b' },
  ] as const;

  for (const request of requests) {
    assert.equal(
      await codeOf(
        h
          .comments()
          .add(
            request as Parameters<ReturnType<Harness['comments']>['add']>[0],
          ),
      ),
      'invalid_input',
      JSON.stringify(request),
    );
  }

  assert.deepEqual(h.threadEvents, []);
  assert.deepEqual(h.appends, []);
});

void test('C8: a chosen id already written answers that comment; a reply to a reply lands under the root; an unknown inReplyTo is invalid_input', async (t) => {
  const h = await activated(t);
  const target = wireTarget(onElement);
  const first = await h.comments().add({
    target,
    text: 'raiz',
    commentId: 'comment-root',
  });
  const again = await h.comments().add({
    target: wireTarget(onSpace),
    text: 'outra coisa',
    commentId: 'comment-root',
  });

  assert.deepEqual(domainOf(again.comment), domainOf(first.comment));
  assert.equal(h.appends.length, 1);

  await h.comments().add({
    target,
    text: 'resposta',
    commentId: 'comment-r1',
    inReplyTo: 'comment-root',
  });
  await h.comments().add({
    target,
    text: 'resposta da resposta',
    commentId: 'comment-r2',
    inReplyTo: 'comment-r1',
  });

  assert.equal(h.appends[1]?.request.payload.inReplyTo, 'comment-root');
  assert.equal(h.appends[2]?.request.payload.inReplyTo, 'comment-root');

  assert.equal(
    await codeOf(
      h.comments().add({ target, text: 'nota', inReplyTo: 'comment-unknown' }),
    ),
    'invalid_input',
  );
  assert.equal(h.appends.length, 3);
});

void test('C9: a failed Append fails Add with its code and leaves nothing to list', async (t) => {
  const h = await activated(t);

  for (const code of ['invalid_scope', 'unavailable'] as const) {
    h.failures.append = new ContractError(code, 'refused');

    assert.equal(
      await codeOf(
        h.comments().add({ target: wireTarget(onElement), text: 'nota' }),
      ),
      code,
    );
  }

  h.failures.append = undefined;

  assert.deepEqual(await listed(h), []);
  assert.deepEqual(h.log.rows, []);
});

// ---------------------------------------------------------------------------
// C10–C12: List.

void test('C10: List answers the Thread’s comments in log order, filters by kind and target identity, and folds a Project’s Threads in ProjectThreads order', async (t) => {
  const h = await activated(t);
  const add = async (
    target: CommentTarget,
    text: string,
    scope = promptScope,
  ) =>
    domainOf(
      (await h.comments(scope).add({ target: wireTarget(target), text }))
        .comment,
    );

  const first = await add(onElement, 'um');
  const second = await add(onSpace, 'dois');
  const third = await add(onSecondRevision, 'três');
  const fourth = await add(onMessage, 'quatro');
  const elsewhere = await add(onElement, 'outra Thread', otherThread);

  await add(onElement, 'outro Project', otherProject);

  assert.deepEqual(await listed(h), [first, second, third, fourth]);
  assert.deepEqual(await listed(h, { kind: 'message' }), [fourth]);
  assert.deepEqual(
    await listed(h, {
      target: { kind: 'artifact', id: 'checkout-7f3a', revision: 1 },
    }),
    [first, second],
  );
  assert.deepEqual(
    await listed(h, {
      kind: 'artifact',
      target: { kind: 'artifact', id: 'checkout-7f3a', revision: 2 },
    }),
    [third],
  );

  h.timeline.length = 0;

  assert.deepEqual(await listed(h, {}, projectScope), [
    first,
    second,
    third,
    fourth,
    elsewhere,
  ]);
  assert.deepEqual(h.timeline, [
    'threads.projectThreads:project-1',
    'threads.threadEvents:thread-1',
    'threads.threadEvents:thread-2',
  ]);
});

void test('S62b 16: a log ThreadEvents cuts into pages of two is read whole: List folds every comments.* row', async (t) => {
  const h = await activated(t);
  const comments: JsonValue[] = [];

  for (const text of ['um', 'dois', 'três', 'quatro', 'cinco']) {
    comments.push(
      domainOf(
        (await h.comments().add({ target: wireTarget(onElement), text }))
          .comment,
      ),
    );
  }
  const last = comments.at(-1) as JsonObject;
  await h
    .comments()
    .resolve({ commentId: String(last.commentId), resolved: true });

  h.paging.pageSize = 2;
  h.threadEvents.length = 0;

  assert.deepEqual(await listed(h), [
    ...comments.slice(0, -1),
    { ...last, resolved: true },
  ]);
  assert.ok(
    h.threadEvents.length > 1,
    'the log was read over more than one page',
  );
});

void test('C11: List without a projectId is invalid_scope', async (t) => {
  const h = await activated(t);

  assert.equal(await codeOf(h.unscoped().list({})), 'invalid_scope');
  assert.deepEqual(h.threadEvents, []);
});

void test('C12: a log of 1.x rows, one of message-JSON rows and a mix of both list the same comments; a row that parses neither way is skipped', async (t) => {
  const created = '2026-11-20T09:00:00.000Z';
  const added1x = (commentId: string) => ({
    type: 'comments.added/v1',
    commentId,
    target: plain(onElement) as JsonObject,
    text: `nota ${commentId}`,
    author: 'jao',
    createdAt: created,
  });
  const addedJson = (commentId: string) => ({
    type: 'comments.added/v1',
    commentId,
    target: nestedTarget(onElement),
    text: `nota ${commentId}`,
    author: 'jao',
    createdAt: created,
  });
  const resolved1x = (commentId: string, resolved: boolean) => ({
    type: 'comments.resolved/v1',
    commentId,
    resolved,
  });
  const resolvedJson = (commentId: string, resolved: boolean): JsonObject =>
    resolved
      ? { type: 'comments.resolved/v1', commentId, resolved }
      : { type: 'comments.resolved/v1', commentId };
  const history = (
    added: (id: string) => JsonObject,
    resolved: (id: string, value: boolean) => JsonObject,
  ): ThreadEvent[] =>
    [
      added('comment-a'),
      added('comment-b'),
      resolved('comment-a', true),
      resolved('comment-a', false),
      resolved('comment-b', true),
      { type: 'comments.added/v1', commentId: 'comment-broken' },
    ].map((event, index) => row(index + 1, String(event.type), event));
  const expected = [
    {
      commentId: 'comment-a',
      target: plain(onElement),
      text: 'nota comment-a',
      author: 'jao',
      resolved: false,
      createdAt: created,
    },
    {
      commentId: 'comment-b',
      target: plain(onElement),
      text: 'nota comment-b',
      author: 'jao',
      resolved: true,
      createdAt: created,
    },
  ];

  for (const [name, rows] of [
    ['1.x', history(added1x, resolved1x)],
    ['message JSON', history(addedJson, resolvedJson)],
    ['mixed', history(added1x, resolvedJson)],
    ['mixed the other way', history(addedJson, resolved1x)],
  ] as const) {
    const h = await activated(t, logOf(rows));

    assert.deepEqual(await listed(h), expected, name);
  }
});

// ---------------------------------------------------------------------------
// C13–C14: Resolve and failing reads.

void test('C13: Resolve appends one CommentsResolved per change, nothing for the same state, {} for another Thread’s comment, and a routed reopen lists open', async (t) => {
  const h = await activated(t);
  const { comment } = await h.comments().add({
    target: wireTarget(onElement),
    text: 'nota',
    commentId: 'comment-1',
  });
  const resolvedOf = () =>
    h.appends.filter(({ request }) => request.type === 'comments.resolved/v1');

  const done = await h
    .comments()
    .resolve({ commentId: 'comment-1', resolved: true });

  assert.deepEqual(domainOf(done.comment), {
    ...(domainOf(comment) as JsonObject),
    resolved: true,
  });
  assert.equal(resolvedOf().length, 1);
  assert.deepEqual(resolvedOf()[0]?.request.payload, {
    commentId: 'comment-1',
    resolved: true,
  });

  const again = await h
    .comments()
    .resolve({ commentId: 'comment-1', resolved: true });

  assert.equal((domainOf(again.comment) as JsonObject).resolved, true);
  assert.equal(resolvedOf().length, 1);

  await h.comments(otherThread).add({
    target: wireTarget(onElement),
    text: 'nota',
    commentId: 'comment-elsewhere',
  });

  const foreign = await h.comments().resolve({
    commentId: 'comment-elsewhere',
    resolved: true,
  });

  assert.equal(foreign.comment, undefined);
  assert.equal(resolvedOf().length, 1);

  const reopened = await h.comments().resolve({
    commentId: 'comment-1',
    resolved: false,
  });

  assert.equal((domainOf(reopened.comment) as JsonObject).resolved, false);
  assert.equal(resolvedOf().length, 2);
  assert.deepEqual(
    (await listed(h)).map((entry) => (entry as JsonObject).resolved),
    [false],
  );
});

void test('C14: ThreadEvents or ProjectThreads failing unavailable fails List, Resolve and Add with an id unavailable, not internal', async (t) => {
  const h = await activated(t);
  const unavailable = new ContractError('unavailable', 'runtime is gone');

  h.failures.threadEvents = unavailable;

  assert.equal(await codeOf(h.comments().list({})), 'unavailable');
  assert.equal(
    await codeOf(
      h.comments().resolve({ commentId: 'comment-1', resolved: true }),
    ),
    'unavailable',
  );
  assert.equal(
    await codeOf(
      h.comments().add({
        target: wireTarget(onElement),
        text: 'nota',
        commentId: 'comment-1',
      }),
    ),
    'unavailable',
  );

  h.failures.threadEvents = undefined;
  h.failures.projectThreads = unavailable;

  assert.equal(await codeOf(h.comments(projectScope).list({})), 'unavailable');
  assert.deepEqual(h.appends, []);
});

// ---------------------------------------------------------------------------
// C15–C17: comment_reply.

void test('C15: Execute of comment_reply appends the agent’s reply under the root with its target, resolves it when asked, and answers {commentId, inReplyTo, resolved}', async (t) => {
  const h = await activated(t);

  await h.comments().add({
    target: wireTarget(onElement),
    text: 'aumenta o respiro',
    author: 'jao',
    commentId: 'comment-root',
  });

  const open = (await reply(h, {
    comment_id: 'comment-root',
    text: 'Aumentei o padding.',
  })) as JsonObject;

  assert.match(String(open.commentId), GENERATED_ID);
  assert.deepEqual(open, {
    commentId: open.commentId,
    inReplyTo: 'comment-root',
    resolved: false,
  });
  assert.deepEqual(h.appends[1]?.request, {
    type: 'comments.added/v1',
    payload: {
      commentId: open.commentId,
      target: nestedTarget(onElement),
      text: 'Aumentei o padding.',
      author: 'agent',
      createdAt: h.appends[1]?.request.payload.createdAt ?? null,
      inReplyTo: 'comment-root',
    },
  });
  assert.equal(h.appends.length, 2);

  const done = (await reply(h, {
    comment_id: String(open.commentId),
    text: 'Feito.',
    resolve: true,
  })) as JsonObject;

  assert.deepEqual(done, {
    commentId: done.commentId,
    inReplyTo: 'comment-root',
    resolved: true,
  });
  assert.equal(h.appends[2]?.request.payload.inReplyTo, 'comment-root');
  assert.deepEqual(h.appends[3]?.request, {
    type: 'comments.resolved/v1',
    payload: { commentId: 'comment-root', resolved: true },
  });
  assert.deepEqual(h.appends[3]?.scope, promptScope);
});

void test('C16: comment_reply with an unknown id, or one of another Thread, is invalid_input with the kernel’s message and writes nothing', async (t) => {
  const h = await activated(t);

  await h.comments(otherThread).add({
    target: wireTarget(onElement),
    text: 'nota',
    commentId: 'comment-root',
  });

  for (const id of ['comment-unknown', 'comment-root']) {
    const error = await rejectionOf(reply(h, { comment_id: id, text: 'ok' }));

    assert.equal(error.code, 'invalid_input', id);
    assert.equal(error.message, UNKNOWN_COMMENT(id));
  }

  assert.equal(h.appends.length, 1);
});

void test('C17: Check refuses a missing text, an empty comment_id or an extra key without reading the log, and accepts a valid payload', async (t) => {
  const h = await activated(t);

  for (const payload of [
    { comment_id: 'comment-1' },
    { comment_id: '', text: 'ok' },
    { comment_id: 'comment-1', text: 'ok', extra: true },
  ] as JsonObject[]) {
    const answer = await h.tools().check({
      name: 'comment_reply',
      payload: fromJson(ValueSchema, payload),
    });

    assert.equal(answer.success, false, JSON.stringify(payload));
    assert.ok(answer.issues.length > 0, JSON.stringify(payload));
  }

  const valid = { comment_id: 'comment-1', text: 'ok', resolve: true };
  const accepted = await h.tools().check({
    name: 'comment_reply',
    payload: fromJson(ValueSchema, valid),
  });

  assert.equal(accepted.success, true);
  assert.deepEqual(
    accepted.data === undefined
      ? undefined
      : toJson(ValueSchema, accepted.data),
    valid,
  );
  assert.deepEqual(h.threadEvents, []);
});

// ---------------------------------------------------------------------------
// P1–P8: what the kernel suite `comments.test.ts` covered and C1–C17 do not
// (S68a, X3), ported to the router harness.

void test('P1: every anchor form C4 writes lists back as written, an absent author left absent', async (t) => {
  const h = await activated(t);
  const unseated: CommentTarget = {
    kind: 'message',
    id: 'prompt-1',
    anchor: { form: 'range', text: 'essa resposta' },
  };
  const targets = [...everyForm, unseated];

  for (const target of targets) {
    await h.comments().add({ target: wireTarget(target), text: 'nota' });
  }

  const comments = (await listed(h)) as JsonObject[];

  assert.deepEqual(
    comments.map((entry) => entry.target),
    targets.map(plain),
  );
  assert.equal(
    (await h.comments().list({})).comments[1]?.author,
    undefined,
    'the second comment was written without an author',
  );
});

void test('P2: a seat whose block, offset or item is not a 0-based index, an empty turn, or an offset or item without its seat is invalid_input', async (t) => {
  const h = await activated(t);
  const seat = { form: 'range', text: 'essa resposta', turn: 'agent:p:3' };

  for (const anchor of [
    { ...seat, block: -1 },
    { ...seat, turn: '', block: 2 },
    { ...seat, block: 2, at: -1 },
    { ...seat, block: 2, at: 0.5 },
    { ...seat, block: 2, item: -1 },
    { form: 'range', text: 'essa resposta', item: 0 },
  ] as const) {
    assert.equal(
      await codeOf(
        h.comments().add({
          target: wireTarget({
            kind: 'message',
            id: 'prompt-1',
            anchor,
          } as CommentTarget),
          text: 'nota',
        }),
      ),
      'invalid_input',
      JSON.stringify(anchor),
    );
  }

  assert.deepEqual(h.appends, []);
});

void test('P3: a pseudo-element other than ::before or ::after, and a chosen id outside the format, are invalid_input; a 128-character id is accepted', async (t) => {
  const h = await activated(t);

  for (const pseudo of ['after', '']) {
    assert.equal(
      await codeOf(
        h.comments().add({
          target: wireTarget({
            kind: 'artifact',
            id: 'a',
            anchor: { form: 'source', path: 'src/App.tsx', pseudo },
          } as CommentTarget),
          text: 'nota',
        }),
      ),
      'invalid_input',
      JSON.stringify(pseudo),
    );
  }

  for (const commentId of ['', 'slash/id', 'acentuação', 'x'.repeat(129)]) {
    assert.equal(
      await codeOf(
        h.comments().add({
          target: wireTarget(onElement),
          text: 'nota',
          commentId,
        }),
      ),
      'invalid_input',
      JSON.stringify(commentId),
    );
  }

  assert.deepEqual(h.appends, []);

  const longest = 'x'.repeat(128);
  const { comment } = await h.comments().add({
    target: wireTarget(onElement),
    text: 'nota',
    commentId: longest,
  });

  assert.equal(comment?.commentId, longest);
});

void test('P4: a fresh activation over the same log lists what an earlier one wrote and resolved', async (t) => {
  const log = threadLog();
  const first = harness(log);

  await first.activate();

  try {
    const { comment } = await first.comments().add({
      target: wireTarget(onElement),
      text: 'sobrevive ao reinício',
      author: 'jao',
    });

    await first
      .comments()
      .resolve({ commentId: comment?.commentId ?? '', resolved: true });
  } finally {
    await first.router.control.stop();
  }

  const restarted = await activated(t, log);
  const [only, ...rest] = (await restarted.comments().list({})).comments;

  assert.deepEqual(rest, []);
  assert.equal(only?.text, 'sobrevive ao reinício');
  assert.equal(only?.author, 'jao');
  assert.equal(only?.resolved, true);
});

void test('P5: Resolve of an id never written, or from another Thread or Project, answers no comment, appends nothing and leaves the comment open', async (t) => {
  const h = await activated(t);

  await h.comments().add({
    target: wireTarget(onElement),
    text: 'desta conversa',
    commentId: 'comment-1',
  });

  const unknown = await h
    .comments()
    .resolve({ commentId: 'comment-unknown', resolved: true });

  assert.equal(unknown.comment, undefined);

  for (const scope of [otherThread, otherProject]) {
    const foreign = await h
      .comments(scope)
      .resolve({ commentId: 'comment-1', resolved: true });

    assert.equal(foreign.comment, undefined, JSON.stringify(scope));
  }

  assert.equal(h.appends.length, 1);
  assert.deepEqual(
    (await listed(h)).map((entry) => (entry as JsonObject).resolved),
    [false],
  );
});

void test('P6: a failed Append fails Resolve with its code and leaves the comment open', async (t) => {
  const h = await activated(t);

  await h.comments().add({
    target: wireTarget(onElement),
    text: 'ajusta o espaçamento',
    commentId: 'comment-1',
  });

  h.failures.append = new ContractError('unavailable', 'refused');

  assert.equal(
    await codeOf(
      h.comments().resolve({ commentId: 'comment-1', resolved: true }),
    ),
    'unavailable',
  );

  h.failures.append = undefined;

  assert.deepEqual(
    (await listed(h)).map((entry) => (entry as JsonObject).resolved),
    [false],
  );
});

void test('P7: a retried Add of a resolved comment answers it resolved and appends nothing; the same id in another Thread is another comment', async (t) => {
  const h = await activated(t);
  const input = {
    target: wireTarget(onElement),
    text: 'resolvida',
    commentId: 'comment-done',
  };

  await h.comments().add(input);
  await h.comments().resolve({ commentId: 'comment-done', resolved: true });

  const retried = await h.comments().add(input);

  assert.equal(retried.comment?.resolved, true);
  assert.equal(h.appends.length, 2);

  const elsewhere = await h.comments(otherThread).add(input);

  assert.equal(elsewhere.comment?.resolved, false);
  assert.equal(h.appends.length, 3);
  assert.deepEqual(h.appends[2]?.scope, otherThread);
});

void test('P8: replies — one to another Thread’s comment is invalid_input; a retried batch of a root and its reply lists both once, in order; resolving the root keeps the reply open', async (t) => {
  const h = await activated(t);

  await h.comments(otherThread).add({
    target: wireTarget(onElement),
    text: 'de outra conversa',
    commentId: 'comment-elsewhere',
  });

  assert.equal(
    await codeOf(
      h.comments().add({
        target: wireTarget(onElement),
        text: 'resposta',
        inReplyTo: 'comment-elsewhere',
      }),
    ),
    'invalid_input',
  );
  assert.equal(h.appends.length, 1);

  const batch = [
    { target: wireTarget(onElement), text: 'raiz', commentId: 'comment-root' },
    {
      target: wireTarget(onElement),
      text: 'resposta',
      commentId: 'comment-reply',
      inReplyTo: 'comment-root',
    },
  ];

  for (let attempt = 0; attempt < 2; attempt += 1) {
    for (const input of batch) {
      await h.comments().add(input);
    }
  }

  await h.comments().resolve({ commentId: 'comment-root', resolved: true });

  assert.deepEqual(
    (await h.comments().list({})).comments.map((entry) => [
      entry.commentId,
      entry.inReplyTo,
      entry.resolved,
    ]),
    [
      ['comment-root', undefined, true],
      ['comment-reply', 'comment-root', false],
    ],
  );
  assert.equal(
    h.appends.filter(({ request }) => request.type === 'comments.added/v1')
      .length,
    3,
  );
});
