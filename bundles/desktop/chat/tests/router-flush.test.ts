// F1–F9 (phase 3, S58): the flushes of `chat.composer/v1` in `chat`'s host
// part. `chat` flushes its own `message` kind in process (never through the
// router to itself) and serves the same function as its
// `ComposerFlushHandlerService`; another bundle registers a kind with
// `RegisterFlush` (D4's key rule over `RegistrationTable`, today's conflict
// text) and `Flush` calls that registrant's handler service, whose answer is
// read back as domain writes. Flushes of one draft run one at a time and
// commit by id (D3).

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  create,
  fromJson,
  type JsonValue,
  type MessageInitShape,
  toJson,
} from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';
import type { Client } from '@connectrpc/connect';
import { ContractError, toConnectError } from 'bundle/contracts';
import type { BundleInstance, StampedCaller } from 'bundle/host';

import {
  type ComposerCommentWrite as ComposerCommentWriteMessage,
  ComposerCommentWriteSchema,
  type ComposerFlushed as ComposerFlushedMessage,
  type ComposerFlushHandlerService,
  ComposerFlushHandlerServiceFlushRequestSchema,
  ComposerFlushHandlerServiceFlushResponseSchema,
  type ComposerService,
} from '../src/contracts/gen/doric/chat/composer/v1/composer_pb.js';
import {
  type ComposerCommentWrite,
  type ComposerFlush,
  type ComposerItem,
  READER_NAME,
} from '../src/contracts/index.js';
import { createComposerFlushes } from '../src/host/flushes.js';
import {
  type ChatWorld,
  chatWorld,
  deferred,
  type FlushAnswer,
  failureOf,
  itemJson,
  openWatch,
  PREVIEW,
  projectId,
  REMOTE_KIND,
  threadId,
  until,
} from './support/router.js';

type WriteInit = MessageInitShape<typeof ComposerCommentWriteSchema>;

const value = (json: JsonValue) => fromJson(ValueSchema, json);

const messageTarget = {
  kind: 'message',
  id: 'prompt-answered',
  anchor: {
    form: 'range',
    text: 'essa resposta',
    turn: 'turn-1',
    block: 2,
    at: 5,
  },
};

/** The wire JSON of `messageTarget`: the anchor's form is the oneof case. */
const messageTargetJson = {
  kind: 'message',
  id: 'prompt-answered',
  anchor: { range: { text: 'essa resposta', turn: 'turn-1', block: 2, at: 5 } },
};

const messageItem = (
  note: string,
  data: JsonValue = { target: messageTarget },
) => ({
  threadId,
  kind: 'message',
  elementTag: 'chat-comment-line',
  data: value(data),
  note,
});

const remoteItem = (note: string, data: JsonValue = { program: 'p-1' }) => ({
  threadId,
  kind: REMOTE_KIND,
  elementTag: 'papercraft-comment-line',
  data: value(data),
  note,
});

/** One write of every anchor form, each field set, as a registrant answers them. */
const REMOTE_WRITES: WriteInit[] = [
  {
    target: {
      kind: REMOTE_KIND,
      id: 'program-1',
      revision: 3,
      anchor: {
        form: {
          case: 'source',
          value: {
            path: 'src/app.tsx',
            line: 4,
            label: 'App',
            pseudo: '::before',
          },
        },
      },
    },
    text: 'a source',
    author: 'ana',
    commentId: 'comment-source',
  },
  {
    target: {
      kind: REMOTE_KIND,
      id: 'program-1',
      anchor: {
        form: {
          case: 'selector',
          value: { selector: 'main > h1', label: 'h1', pseudo: '::after' },
        },
      },
    },
    text: 'a selector',
    inReplyTo: 'comment-root',
  },
  {
    target: {
      kind: REMOTE_KIND,
      id: 'program-1',
      anchor: {
        form: { case: 'point', value: { x: 12.5, y: 40, label: 'div' } },
      },
    },
    text: 'a point',
  },
  {
    target: {
      kind: REMOTE_KIND,
      id: 'program-1',
      anchor: {
        form: {
          case: 'range',
          value: { text: 'the words', turn: 't-2', block: 1, at: 3, item: 2 },
        },
      },
    },
    text: 'a range',
    author: 'bia',
    commentId: 'comment-range',
  },
];

const writeJson = (write: WriteInit | ComposerCommentWriteMessage): JsonValue =>
  toJson(ComposerCommentWriteSchema, create(ComposerCommentWriteSchema, write));

/** A `Flush` answer as plain values: each item through `itemJson`, each write as JSON. */
const flushedView = (flushed: readonly ComposerFlushedMessage[]) =>
  flushed.map((entry) => ({
    item: entry.item === undefined ? undefined : itemJson(entry.item),
    writes: entry.writes.map(writeJson),
  }));

const idOf = (answer: { composerItem?: { id: string } }): string =>
  answer.composerItem?.id ?? assert.fail('AddItem answered no item');

const readIds = async (
  composer: Client<typeof ComposerService>,
): Promise<string[]> =>
  ((await composer.read({ threadId })).composerSnapshot?.items ?? []).map(
    (item) => item.id,
  );

/** A response's own fields, without `$typeName`. */
const fieldsOf = (message: object): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(message).filter(([key]) => !key.startsWith('$')),
  );

/** A thrown value's code, message and details, whichever copy of `ContractError` made it. */
const errorView = (error: unknown) => {
  const { code, message, details } = error as ContractError;
  return { code, message, details };
};

const activated = async (
  t: test.TestContext,
  remote = false,
): Promise<ChatWorld> => {
  const world = chatWorld({ remote });
  t.after(() => world.stop());
  await world.activate();
  return world;
};

void test('F1: a message item flushes in process to one write; a blank note, no target or an anchor the wire cannot hold stays', async (t) => {
  const world = await activated(t);
  const composer = world.composer();

  const flushing = await composer.addItem(messageItem('  hi '));
  const blank = await composer.addItem(messageItem('   '));
  const untargeted = await composer.addItem(messageItem('no target', {}));
  const circle = await composer.addItem(
    messageItem('a circle', {
      target: {
        kind: 'message',
        id: 'prompt-answered',
        anchor: { form: 'circle', text: 'x' },
      },
    }),
  );
  const reply = await composer.addItem(
    messageItem('e mais isso', {
      target: messageTarget,
      inReplyTo: 'comment-logged',
    }),
  );

  const watch = openWatch(composer);
  t.after(() => watch.cancel());
  await until(() => watch.responses.length === 1, 'the snapshot');
  const revision = watch.responses[0]?.revision ?? assert.fail('no snapshot');

  const answer = await composer.flush({ threadId, promptId: 'prompt-2' });

  assert.deepEqual(flushedView(answer.flushed), [
    {
      item: itemJson(flushing.composerItem ?? assert.fail()),
      writes: [
        {
          target: messageTargetJson,
          text: 'hi',
          author: READER_NAME,
          commentId: idOf(flushing),
        },
      ],
    },
    {
      item: itemJson(reply.composerItem ?? assert.fail()),
      writes: [
        {
          target: messageTargetJson,
          text: 'e mais isso',
          author: READER_NAME,
          commentId: idOf(reply),
          inReplyTo: 'comment-logged',
        },
      ],
    },
  ]);
  assert.deepEqual(await readIds(composer), [
    idOf(blank),
    idOf(untargeted),
    idOf(circle),
  ]);
  await until(() => watch.responses.length === 3, 'the removed deltas');
  assert.deepEqual(watch.views().slice(1), [
    { revision: revision + 1, kind: 'removed', threadId, id: idOf(reply) },
    { revision: revision + 2, kind: 'removed', threadId, id: idOf(flushing) },
  ]);
});

void test('F2: a registered kind flushes through its registrant’s handler service with the item and the context, its writes answered unchanged, in stack order', async (t) => {
  const world = await activated(t, true);
  const composer = world.composer();

  const registered = await composer.registerFlush({ kind: REMOTE_KIND });
  assert.ok(registered.registrationId.length > 0);
  world.script(() => ({ writes: REMOTE_WRITES }));

  const message = await composer.addItem(messageItem('the message'));
  const remote = await composer.addItem(remoteItem('the program'));
  const stranger = await composer.addItem({
    threadId,
    kind: 'unregistered',
    elementTag: 'x-line',
    note: 'nobody flushes me',
  });
  const waiting = await composer.addItem(
    remoteItem('a reply to a drafted root', { inReplyTo: idOf(stranger) }),
  );

  const answer = await composer.flush(
    { threadId, promptId: 'prompt-2' },
    { timeoutMs: 30_000 },
  );

  assert.deepEqual(flushedView(answer.flushed), [
    {
      item: itemJson(message.composerItem ?? assert.fail()),
      writes: [
        {
          target: messageTargetJson,
          text: 'the message',
          author: READER_NAME,
          commentId: idOf(message),
        },
      ],
    },
    {
      item: itemJson(remote.composerItem ?? assert.fail()),
      writes: REMOTE_WRITES.map(writeJson),
    },
  ]);
  assert.equal(world.flushCalls.length, 1);
  const [call] = world.flushCalls;
  assert.deepEqual(
    call?.request,
    toJson(
      ComposerFlushHandlerServiceFlushRequestSchema,
      create(ComposerFlushHandlerServiceFlushRequestSchema, {
        item: remote.composerItem,
        context: { projectId, threadId, promptId: 'prompt-2' },
      }),
    ),
  );
  assert.ok((call?.deadline ?? 0) > 0, 'the flush carries the call’s deadline');
  assert.deepEqual(await readIds(composer), [idOf(stranger), idOf(waiting)]);
});

void test('F3: a registrant’s failure fails Flush with its code, message and details, and a write without target is invalid_output; the draft is unchanged', async (t) => {
  const world = await activated(t, true);
  const composer = world.composer();
  await composer.registerFlush({ kind: REMOTE_KIND });
  const item = await composer.addItem(remoteItem('the program'));

  const watch = openWatch(composer);
  t.after(() => watch.cancel());
  await until(() => watch.responses.length === 1, 'the snapshot');
  const revision = watch.responses[0]?.revision ?? assert.fail('no snapshot');

  world.script(() => {
    throw new ContractError('unavailable', 'The preview is gone.', { x: 1 });
  });
  const failure = await failureOf(() =>
    composer.flush({ threadId, promptId: 'prompt-2' }),
  );
  assert.deepEqual(
    { code: failure.code, message: failure.message, details: failure.details },
    { code: 'unavailable', message: 'The preview is gone.', details: { x: 1 } },
  );
  assert.deepEqual(await readIds(composer), [idOf(item)]);

  world.script(() => ({ writes: [{ text: 'no target' }] }));
  assert.equal(
    (await failureOf(() => composer.flush({ threadId, promptId: 'prompt-3' })))
      .code,
    'invalid_output',
  );
  assert.deepEqual(await readIds(composer), [idOf(item)]);

  await composer.setText({ threadId, text: 'a change' });
  await until(() => watch.responses.length === 2, 'the text delta');
  assert.deepEqual(watch.views().slice(1), [
    { revision: revision + 1, kind: 'text', threadId, text: 'a change' },
  ]);
});

void test('F4: while a flush awaits its handler, an added item is not flushed by it and a removed held item is not put back', async (t) => {
  const world = await activated(t, true);
  const composer = world.composer();
  await composer.registerFlush({ kind: REMOTE_KIND });
  const pending = deferred<FlushAnswer>();
  world.script((request) =>
    request.item?.note === 'first'
      ? pending.promise
      : { writes: REMOTE_WRITES },
  );

  const first = await composer.addItem(remoteItem('first'));
  const held = await composer.addItem({
    threadId,
    kind: 'unregistered',
    elementTag: 'x-line',
    note: 'held',
  });

  const flushing = composer.flush({ threadId, promptId: 'prompt-2' });
  await until(() => world.flushCalls.length === 1, 'the handler call');
  const later = await composer.addItem(remoteItem('later'));
  await composer.removeItem({ threadId, id: idOf(held) });
  pending.resolve({ writes: [REMOTE_WRITES[0] as WriteInit] });

  const answer = await flushing;
  assert.deepEqual(
    answer.flushed.map((entry) => entry.item?.id),
    [idOf(first)],
  );
  assert.equal(world.flushCalls.length, 1);
  assert.deepEqual(await readIds(composer), [idOf(later)]);
});

void test('F4: a second Flush of the same Thread waits for the first and answers nothing', async (t) => {
  const world = await activated(t, true);
  const composer = world.composer();
  await composer.registerFlush({ kind: REMOTE_KIND });
  const pending = deferred<FlushAnswer>();
  world.script(() => pending.promise);
  const item = await composer.addItem(remoteItem('once'));

  const watch = openWatch(composer);
  t.after(() => watch.cancel());
  await until(() => watch.responses.length === 1, 'the snapshot');

  const firstFlush = composer.flush({ threadId, promptId: 'prompt-2' });
  await until(() => world.flushCalls.length === 1, 'the handler call');
  let secondSettled = false;
  const secondFlush = composer
    .flush({ threadId, promptId: 'prompt-3' })
    .finally(() => {
      secondSettled = true;
    });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(secondSettled, false, 'the second flush waits for the first');

  pending.resolve({ writes: [REMOTE_WRITES[0] as WriteInit] });
  const [first, second] = await Promise.all([firstFlush, secondFlush]);

  assert.deepEqual(
    first.flushed.map((entry) => entry.item?.id),
    [idOf(item)],
  );
  assert.deepEqual(second.flushed, []);
  assert.equal(world.flushCalls.length, 1);
  await until(() => watch.responses.length === 2, 'the removed delta');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(
    watch
      .views()
      .slice(1)
      .map((view) => view.kind),
    ['removed'],
  );
});

void test('F5: RegisterFlush answers the same id to the same caller, and refuses another bundle’s kind and the message kind with today’s text', async (t) => {
  const world = await activated(t, true);
  const papercraft = world.composer();
  const preview = world.composer({ caller: PREVIEW });

  const first = await papercraft.registerFlush({ kind: REMOTE_KIND });
  const again = await papercraft.registerFlush({ kind: REMOTE_KIND });
  assert.equal(again.registrationId, first.registrationId);

  const conflict = await failureOf(() =>
    preview.registerFlush({ kind: REMOTE_KIND }),
  );
  assert.deepEqual(
    {
      code: conflict.code,
      message: conflict.message,
      details: conflict.details,
    },
    {
      code: 'registration_conflict',
      message: `The ${REMOTE_KIND} comment kind already has a flush.`,
      details: { kind: REMOTE_KIND },
    },
  );

  for (const client of [papercraft, preview]) {
    const own = await failureOf(() =>
      client.registerFlush({ kind: 'message' }),
    );
    assert.deepEqual(
      { code: own.code, message: own.message, details: own.details },
      {
        code: 'registration_conflict',
        message: 'The message comment kind already has a flush.',
        details: { kind: 'message' },
      },
    );
  }
});

void test('F6: Unregister of the caller’s own id ends its flush; an unknown id or another bundle’s id changes nothing', async (t) => {
  const world = await activated(t, true);
  const papercraft = world.composer();
  const preview = world.composer({ caller: PREVIEW });
  world.script(() => ({ writes: [REMOTE_WRITES[0] as WriteInit] }));
  const { registrationId } = await papercraft.registerFlush({
    kind: REMOTE_KIND,
  });

  assert.deepEqual(
    fieldsOf(await papercraft.unregister({ registrationId: 'r-unknown' })),
    {},
  );
  assert.deepEqual(fieldsOf(await preview.unregister({ registrationId })), {});
  await papercraft.addItem(remoteItem('still served'));
  assert.equal(
    (await papercraft.flush({ threadId, promptId: 'prompt-2' })).flushed.length,
    1,
  );
  assert.equal(world.flushCalls.length, 1);

  await papercraft.unregister({ registrationId });
  const stays = await papercraft.addItem(remoteItem('no flush any more'));
  assert.deepEqual(
    (await papercraft.flush({ threadId, promptId: 'prompt-3' })).flushed,
    [],
  );
  assert.equal(world.flushCalls.length, 1);
  assert.deepEqual(await readIds(papercraft), [idOf(stays)]);
});

void test('F7: when the registrant’s instance is gone its kind has no flush; another bundle’s registration and message are unaffected', async (t) => {
  const world = await activated(t, true);
  const papercraft = world.composer();
  const preview = world.composer({ caller: PREVIEW });
  world.script(() => ({ writes: [REMOTE_WRITES[0] as WriteInit] }));
  await papercraft.registerFlush({ kind: REMOTE_KIND });
  await preview.registerFlush({ kind: 'preview-pin' });

  world.host.instanceGone({
    bundleId: 'papercraft',
    generation: 1,
    incarnation: 1,
  });

  const remote = await papercraft.addItem(remoteItem('gone'));
  const pin = await papercraft.addItem({
    threadId,
    kind: 'preview-pin',
    elementTag: 'preview-comment-line',
    note: 'pinned',
  });
  const message = await papercraft.addItem(messageItem('the message'));

  const answer = await papercraft.flush({ threadId, promptId: 'prompt-2' });

  assert.deepEqual(
    answer.flushed.map((entry) => entry.item?.id),
    [idOf(pin), idOf(message)],
  );
  assert.equal(world.flushCalls.length, 1);
  assert.deepEqual(await readIds(papercraft), [idOf(remote)]);
});

void test('F8: createComposerFlushes calls the newest instance of the registering bundle, the next newest once it is dropped, and reads a ConnectError as its ContractError', async () => {
  const self: BundleInstance = {
    bundleId: 'chat',
    generation: 1,
    incarnation: 1,
  };
  const localCalls: string[] = [];
  const local: ComposerFlush = (item) => {
    localCalls.push(item.id);
    return Promise.resolve([]);
  };
  const targets: StampedCaller[] = [];
  const requests: JsonValue[] = [];
  let failWith: ContractError | undefined;
  const flushes = createComposerFlushes({
    self,
    local: new Map([['message', local]]),
    handlerOf: (caller) => {
      targets.push(caller);
      return {
        flush: (
          request: MessageInitShape<
            typeof ComposerFlushHandlerServiceFlushRequestSchema
          >,
        ) => {
          requests.push(
            toJson(
              ComposerFlushHandlerServiceFlushRequestSchema,
              create(ComposerFlushHandlerServiceFlushRequestSchema, request),
            ),
          );
          if (failWith !== undefined) {
            return Promise.reject(toConnectError(failWith));
          }
          return Promise.resolve(
            create(ComposerFlushHandlerServiceFlushResponseSchema, {
              writes: [REMOTE_WRITES[3] as WriteInit],
            }),
          );
        },
      } as unknown as Client<typeof ComposerFlushHandlerService>;
    },
  });

  const instance = (
    generation: number,
    incarnation: number,
  ): StampedCaller => ({
    bundleId: 'papercraft',
    version: '1.0.0',
    generation,
    incarnation,
  });
  const older = instance(1, 2);
  const newest = instance(2, 1);
  const oldest = instance(1, 1);
  flushes.register(older, REMOTE_KIND);
  flushes.register(newest, REMOTE_KIND);
  flushes.register(oldest, REMOTE_KIND);

  const item: ComposerItem = {
    id: 'comment-a',
    kind: REMOTE_KIND,
    elementTag: 'papercraft-comment-line',
    data: { program: 'p-1' },
    author: 'ana',
    note: 'n',
  };
  const context = { projectId, threadId, promptId: 'prompt-2' };
  const flush = flushes.flushOf(REMOTE_KIND) ?? assert.fail('no flush');
  const writes = await flush(item, context);

  const expected: ComposerCommentWrite = {
    target: {
      kind: REMOTE_KIND,
      id: 'program-1',
      anchor: {
        form: 'range',
        text: 'the words',
        turn: 't-2',
        block: 1,
        at: 3,
        item: 2,
      },
    },
    text: 'a range',
    author: 'bia',
    commentId: 'comment-range',
  };
  assert.deepEqual(writes, [expected]);
  assert.deepEqual(targets.at(-1), newest);
  assert.deepEqual(requests, [
    {
      item: {
        id: 'comment-a',
        kind: REMOTE_KIND,
        elementTag: 'papercraft-comment-line',
        data: { program: 'p-1' },
        author: 'ana',
        note: 'n',
      },
      context,
    },
  ]);

  flushes.dropInstance(newest);
  await (flushes.flushOf(REMOTE_KIND) ?? assert.fail('no flush'))(
    item,
    context,
  );
  assert.deepEqual(targets.at(-1), older);

  failWith = new ContractError('not_found', 'No such program.', {
    program: 'p-1',
  });
  await assert.rejects(
    (flushes.flushOf(REMOTE_KIND) ?? assert.fail('no flush'))(item, context),
    (error: unknown) => {
      assert.deepEqual(errorView(error), {
        code: 'not_found',
        message: 'No such program.',
        details: { program: 'p-1' },
      });
      return true;
    },
  );

  const messageFlush =
    flushes.flushOf('message') ?? assert.fail('no local flush');
  await messageFlush({ ...item, kind: 'message' }, context);
  assert.deepEqual(localCalls, ['comment-a']);
  assert.throws(
    () => flushes.register(newest, 'message'),
    (error: unknown) => {
      assert.deepEqual(errorView(error), {
        code: 'registration_conflict',
        message: 'The message comment kind already has a flush.',
        details: { kind: 'message' },
      });
      return true;
    },
  );
  assert.equal(flushes.flushOf('unregistered'), undefined);
});

void test('F9: chat’s ComposerFlushHandlerService answers a message item with the writes Flush makes, and refuses another kind', async (t) => {
  const world = await activated(t);
  const handler = world.handler();
  const context = { projectId, threadId, promptId: 'prompt-2' };

  const answer = await handler.flush({
    item: {
      id: 'comment-a',
      kind: 'message',
      elementTag: 'chat-comment-line',
      data: value({ target: messageTarget, inReplyTo: 'comment-root' }),
      author: 'ana',
      note: '  hi ',
    },
    context,
  });
  assert.deepEqual(answer.writes.map(writeJson), [
    {
      target: messageTargetJson,
      text: 'hi',
      author: 'ana',
      commentId: 'comment-a',
      inReplyTo: 'comment-root',
    },
  ]);

  const failure = await failureOf(() =>
    handler.flush({
      item: {
        id: 'comment-b',
        kind: REMOTE_KIND,
        elementTag: 'papercraft-comment-line',
        note: 'n',
      },
      context,
    }),
  );
  assert.deepEqual(
    { code: failure.code, message: failure.message },
    { code: 'invalid_input', message: 'chat flushes only the message kind.' },
  );
});
