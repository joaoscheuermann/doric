// R1–R8 (phase 3, S58): `chat.composer/v1` served by `chat`'s host part over
// the router, as `src/host/main.ts` runs it. The draft lives in memory, keyed
// by `(projectId, threadId)`, the Project being the call scope's; `Watch`
// sends the snapshot, then every change with the draft's revision, which
// rises by one per change. Every request is validated before it reaches the
// state, and activation makes no call through the router.

import assert from 'node:assert/strict';
import test from 'node:test';

import { Code, ConnectError } from '@connectrpc/connect';

import { READER_NAME } from '../src/contracts/index.js';
import {
  type ChatWorld,
  chatWorld,
  failureOf,
  itemJson,
  openWatch,
  otherProjectId,
  projectId,
  threadId,
  until,
} from './support/router.js';

const ITEM = {
  threadId,
  kind: 'message',
  elementTag: 'chat-comment-line',
} as const;

const stopAfter = (t: test.TestContext, world: ChatWorld): void => {
  t.after(() => world.stop());
};

const activated = async (t: test.TestContext): Promise<ChatWorld> => {
  const world = chatWorld();
  stopAfter(t, world);
  await world.activate();
  return world;
};

/** A `comment-` id the composer generated (`comment-<uuid>`). */
const GENERATED = /^comment-[0-9a-f-]{36}$/;

void test('R1: Read of an untouched Thread answers an empty draft and creates nothing', async (t) => {
  const world = await activated(t);
  const composer = world.composer();

  const read = await composer.read({ threadId });

  assert.deepEqual(
    {
      threadId: read.composerSnapshot?.threadId,
      text: read.composerSnapshot?.text,
      items: read.composerSnapshot?.items,
    },
    { threadId, text: '', items: [] },
  );

  const watch = openWatch(composer);
  t.after(() => watch.cancel());
  await until(() => watch.responses.length === 1, 'the snapshot');
  assert.deepEqual(watch.views(), [
    { revision: 0, kind: 'snapshot', threadId, text: '', items: [] },
  ]);
});

void test('R2: SetText, AddItem, UpdateNote and RemoveItem change the draft Read answers; AddItem fills id, author and note', async (t) => {
  const world = await activated(t);
  const composer = world.composer();

  await composer.setText({ threadId, text: 'words to send' });
  const object = await composer.addItem({
    ...ITEM,
    data: {
      kind: {
        case: 'structValue',
        value: {
          fields: {
            target: {
              kind: {
                case: 'structValue',
                value: {
                  fields: {
                    id: { kind: { case: 'stringValue', value: 'p' } },
                    nested: {
                      kind: {
                        case: 'listValue',
                        value: {
                          values: [
                            { kind: { case: 'numberValue', value: 1.5 } },
                            { kind: { case: 'stringValue', value: 'two' } },
                          ],
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
  const nulled = await composer.addItem({
    ...ITEM,
    data: { kind: { case: 'nullValue', value: 0 } },
    note: 'a null',
  });
  const text = await composer.addItem({
    ...ITEM,
    data: { kind: { case: 'stringValue', value: 'a string' } },
    author: 'ana',
  });
  const absent = await composer.addItem({ ...ITEM, note: 'no data' });

  const added = [object, nulled, text, absent].map((answer) => {
    assert.ok(answer.composerItem !== undefined);
    return itemJson(answer.composerItem);
  });

  for (const item of added) assert.match(String(item.id), GENERATED);
  assert.deepEqual(
    added.map(({ id: _id, ...rest }) => rest),
    [
      {
        kind: 'message',
        elementTag: 'chat-comment-line',
        data: { target: { id: 'p', nested: [1.5, 'two'] } },
        author: READER_NAME,
        note: '',
      },
      {
        kind: 'message',
        elementTag: 'chat-comment-line',
        data: null,
        author: READER_NAME,
        note: 'a null',
      },
      {
        kind: 'message',
        elementTag: 'chat-comment-line',
        data: 'a string',
        author: 'ana',
        note: '',
      },
      {
        kind: 'message',
        elementTag: 'chat-comment-line',
        author: READER_NAME,
        note: 'no data',
      },
    ],
  );

  await composer.updateNote({
    threadId,
    id: String(added[0]?.id),
    note: 'a better note',
  });
  await composer.removeItem({ threadId, id: String(added[2]?.id) });

  const read = await composer.read({ threadId });
  assert.equal(read.composerSnapshot?.text, 'words to send');
  assert.deepEqual(read.composerSnapshot?.items.map(itemJson), [
    { ...added[0], note: 'a better note' },
    added[1],
    added[3],
  ]);
});

void test('R3: AddItem keeps a comment- id the stack does not hold, and replaces a held one or one without the prefix', async (t) => {
  const world = await activated(t);
  const composer = world.composer();

  const back = await composer.addItem({ ...ITEM, id: 'comment-x' });
  const twice = await composer.addItem({ ...ITEM, id: 'comment-x' });
  const foreign = await composer.addItem({ ...ITEM, id: 'x' });

  assert.equal(back.composerItem?.id, 'comment-x');
  assert.match(String(twice.composerItem?.id), GENERATED);
  assert.match(String(foreign.composerItem?.id), GENERATED);
  assert.deepEqual(
    (await composer.read({ threadId })).composerSnapshot?.items.map(
      (item) => item.id,
    ),
    [back.composerItem?.id, twice.composerItem?.id, foreign.composerItem?.id],
  );
});

void test('R4: the draft is keyed by the scope’s projectId and the threadId; a watch sees only its own draft', async (t) => {
  const world = await activated(t);
  const one = world.composer({ scope: { projectId } });
  const two = world.composer({ scope: { projectId: otherProjectId } });
  const none = world.composer({ scope: {} });

  const watch = openWatch(two);
  t.after(() => watch.cancel());
  await until(() => watch.responses.length === 1, 'the snapshot');

  await one.setText({ threadId, text: 'project one' });
  await none.setText({ threadId, text: 'no project' });
  await one.addItem({ ...ITEM, note: 'one' });

  assert.equal(
    (await one.read({ threadId })).composerSnapshot?.text,
    'project one',
  );
  assert.equal((await two.read({ threadId })).composerSnapshot?.text, '');
  assert.equal(
    (await none.read({ threadId })).composerSnapshot?.text,
    'no project',
  );
  assert.equal(
    (await two.read({ threadId })).composerSnapshot?.items.length,
    0,
  );
  assert.equal(
    (await none.read({ threadId })).composerSnapshot?.items.length,
    0,
  );

  await two.setText({ threadId, text: 'project two' });
  await until(() => watch.responses.length === 2, 'the text delta');
  assert.deepEqual(watch.views(), [
    { revision: 0, kind: 'snapshot', threadId, text: '', items: [] },
    { revision: 1, kind: 'text', threadId, text: 'project two' },
  ]);
});

void test('R5: Watch sends the snapshot, then one item per change in order with the revision rising by one; two watches see the same', async (t) => {
  const world = await activated(t);
  const composer = world.composer();

  await composer.setText({ threadId, text: 'before' });
  const first = openWatch(composer);
  const second = openWatch(composer);
  t.after(() => {
    first.cancel();
    second.cancel();
  });
  await until(
    () => first.responses.length === 1 && second.responses.length === 1,
    'the snapshots',
  );

  await composer.setText({ threadId, text: 'after' });
  const added = await composer.addItem({ ...ITEM, note: 'n' });
  const item = itemJson(added.composerItem ?? assert.fail('no item'));
  await composer.updateNote({ threadId, id: String(item.id), note: 'm' });
  await composer.updateNote({ threadId, id: 'comment-unknown', note: 'x' });
  await composer.removeItem({ threadId, id: String(item.id) });

  const expected = [
    { revision: 1, kind: 'snapshot', threadId, text: 'before', items: [] },
    { revision: 2, kind: 'text', threadId, text: 'after' },
    { revision: 3, kind: 'added', threadId, item },
    { revision: 4, kind: 'updated', threadId, item: { ...item, note: 'm' } },
    { revision: 5, kind: 'removed', threadId, id: item.id },
  ];
  await until(
    () => first.responses.length === 5 && second.responses.length === 5,
    'the deltas',
  );
  assert.deepEqual(first.views(), expected);
  assert.deepEqual(second.views(), expected);
});

void test('R6: a cancelled Watch ends with canceled and the draft goes on; a new Watch starts at the risen revision; stop ends an open Watch', async (t) => {
  const world = chatWorld();
  stopAfter(t, world);
  await world.activate();
  const composer = world.composer();

  const watch = openWatch(composer);
  await until(() => watch.responses.length === 1, 'the snapshot');
  watch.cancel();
  const ended = await watch.ended;
  assert.equal(ConnectError.from(ended).code, Code.Canceled);

  await composer.setText({ threadId, text: 'later' });
  assert.equal(
    (await composer.read({ threadId })).composerSnapshot?.text,
    'later',
  );

  const again = openWatch(composer);
  await until(() => again.responses.length === 1, 'the new snapshot');
  assert.deepEqual(again.views(), [
    { revision: 1, kind: 'snapshot', threadId, text: 'later', items: [] },
  ]);

  await world.stop();
  await until(() => again.done(), 'the open watch to end');
  assert.equal(
    (await failureOf(() => composer.read({ threadId }))).code,
    'unavailable',
  );
});

void test('R7: an empty threadId, kind, elementTag, id, promptId or registrationId is invalid_input and changes nothing', async (t) => {
  const world = await activated(t);
  const composer = world.composer();

  await composer.setText({ threadId, text: 'kept' });
  const held = await composer.addItem({ ...ITEM, note: 'kept' });
  const before = (await composer.read({ threadId })).composerSnapshot;

  const calls: [string, () => Promise<unknown>][] = [
    ['Read', () => composer.read({ threadId: '' })],
    [
      'Watch',
      async () => {
        for await (const _ of composer.watch({ threadId: '' })) break;
      },
    ],
    ['SetText', () => composer.setText({ threadId: '', text: 'x' })],
    ['AddItem threadId', () => composer.addItem({ ...ITEM, threadId: '' })],
    ['AddItem kind', () => composer.addItem({ ...ITEM, kind: '' })],
    ['AddItem elementTag', () => composer.addItem({ ...ITEM, elementTag: '' })],
    ['AddItem id', () => composer.addItem({ ...ITEM, id: '' })],
    [
      'UpdateNote threadId',
      () =>
        composer.updateNote({
          threadId: '',
          id: String(held.composerItem?.id),
          note: 'x',
        }),
    ],
    [
      'UpdateNote id',
      () => composer.updateNote({ threadId, id: '', note: 'x' }),
    ],
    [
      'RemoveItem threadId',
      () =>
        composer.removeItem({
          threadId: '',
          id: String(held.composerItem?.id),
        }),
    ],
    ['RemoveItem id', () => composer.removeItem({ threadId, id: '' })],
    ['Flush threadId', () => composer.flush({ threadId: '', promptId: 'p' })],
    ['Flush promptId', () => composer.flush({ threadId, promptId: '' })],
    ['RegisterFlush', () => composer.registerFlush({ kind: '' })],
    ['Unregister', () => composer.unregister({ registrationId: '' })],
  ];

  for (const [name, call] of calls) {
    assert.equal((await failureOf(call)).code, 'invalid_input', name);
  }

  assert.deepEqual(
    (await composer.read({ threadId })).composerSnapshot,
    before,
  );
});

void test('R8: activation makes no call through the router, and every method answers unavailable before it ran', async (t) => {
  const remote = chatWorld({ remote: true });
  stopAfter(t, remote);
  await remote.activate();
  assert.deepEqual(remote.flushCalls, []);
  assert.deepEqual(
    remote.router.logs.filter((entry) => entry.level === 'error'),
    [],
  );

  const local = chatWorld();
  stopAfter(t, local);
  await local.activate();
  assert.deepEqual(
    local.router.logs.filter((entry) => entry.level === 'error'),
    [],
  );

  const inactive = chatWorld();
  stopAfter(t, inactive);
  await inactive.serveWithoutActivate();
  const composer = inactive.composer();
  const calls: [string, () => Promise<unknown>][] = [
    ['Read', () => composer.read({ threadId })],
    [
      'Watch',
      async () => {
        for await (const _ of composer.watch({ threadId })) break;
      },
    ],
    ['SetText', () => composer.setText({ threadId, text: 'x' })],
    ['AddItem', () => composer.addItem(ITEM)],
    [
      'UpdateNote',
      () => composer.updateNote({ threadId, id: 'comment-1', note: '' }),
    ],
    ['RemoveItem', () => composer.removeItem({ threadId, id: 'comment-1' })],
    ['Flush', () => composer.flush({ threadId, promptId: 'p' })],
    ['RegisterFlush', () => composer.registerFlush({ kind: 'k' })],
    ['Unregister', () => composer.unregister({ registrationId: 'r1' })],
    [
      'ComposerFlushHandlerService.Flush',
      () =>
        inactive.handler().flush({
          item: {
            id: 'comment-1',
            kind: 'message',
            elementTag: 't',
            note: 'n',
          },
          context: { threadId, promptId: 'p' },
        }),
    ],
  ];

  for (const [name, call] of calls) {
    const failure = await failureOf(call);
    assert.deepEqual(
      { code: failure.code, message: failure.message },
      { code: 'unavailable', message: 'chat is not active.' },
      name,
    );
  }
});
