// The views a window holds on the Threads it shows
// (docs/designs/thread-archive.md §6, §10.8): `createThreadViews`, moved from
// the layout with its assertions (`L/tests/thread-views.test.ts:241-333`),
// and `view` of `runtime.records/v1` over it (bundle isolation T3.9). Slice
// S65a: the views are `runtime.threads/v1`'s server stream `ViewThread` over
// the generated client (spec `docs/designs/grpc-processes.md`, section 13,
// "The window from phase 3 to phase 5"); the SDK opens a view that ended with
// `generation_lost` again, and the other silent ends are followed as before.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { MessageInitShape } from '@bufbuild/protobuf';
import { type Client, createClient } from '@connectrpc/connect';
import {
  type ConnectionStatus,
  ContractError,
  type Disposable,
  toConnectError,
} from 'bundle/contracts';

import { createThreadViews } from '../../src/client/api/thread-views.js';
import { activate } from '../../src/client/index.js';
import {
  ThreadsService,
  type ViewThreadRequest,
  type ViewThreadResponseSchema,
} from '../../src/contracts/gen/doric/runtime/threads/v1/threads_pb.js';
import type { RuntimeRecords } from '../../src/contracts/index.js';
import {
  fakeClientServices,
  fakeHostClients,
  settle,
  streamOf,
  until,
} from './support/connect.js';

type ViewItem = MessageInitShape<typeof ViewThreadResponseSchema>;

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';

/** A `ConnectError` the host ends a stream with, read back as `code`. */
const ended = (code: string, message = 'gone for now') =>
  toConnectError(new ContractError(code, message));

class FakeConnection {
  current: ConnectionStatus = 'connected';
  private readonly listeners = new Set<(status: ConnectionStatus) => void>();

  status(): ConnectionStatus {
    return this.current;
  }

  subscribe(listener: (status: ConnectionStatus) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => void this.listeners.delete(listener) };
  }

  report(status: ConnectionStatus): void {
    this.current = status;
    for (const listener of [...this.listeners]) listener(status);
  }
}

/** `runtime.threads/v1.ViewThread` over a fake host, and its openings. */
const fakeViews = () => {
  const views = streamOf<ViewThreadRequest, ViewItem>();
  const host = fakeHostClients((router) => {
    router.service(ThreadsService, { viewThread: views.serve });
  });
  const ids = (openings: readonly { readonly request: ViewThreadRequest }[]) =>
    openings.map(({ request }) => request.threadId).sort();

  return {
    host,
    views,
    /** The ids with an open stream, one entry per open stream. */
    open: () => ids(views.open()),
    opened: (threadId: string) =>
      views.openings.filter(({ request }) => request.threadId === threadId)
        .length,
    openOf: (threadId: string) => {
      const found = views
        .open()
        .find(({ request }) => request.threadId === threadId);
      assert.ok(found !== undefined, `no open stream for ${threadId}`);
      return found;
    },
  };
};

const setup = () => {
  const fake = fakeViews();
  const runtime: Client<typeof ThreadsService> = fake.host.hostClients
    .part('runtime')
    .use(ThreadsService);
  const connection = new FakeConnection();
  const timers: (() => void)[] = [];
  const views = createThreadViews({
    runtime,
    connection,
    schedule: (run) => {
      timers.push(run);
      return () => {
        const index = timers.indexOf(run);
        if (index >= 0) timers.splice(index, 1);
      };
    },
  });
  const fireTimers = () => {
    for (const run of timers.splice(0)) run();
  };
  return { ...fake, connection, views, fireTimers };
};

describe('createThreadViews over ViewThread (T-24)', () => {
  test('set opens one view per new id and ends the views of ids it no longer names', async () => {
    const { views, open, opened } = setup();

    views.set(new Set([A, B]));
    await settle();
    assert.deepEqual(open(), [A, B]);

    views.set(new Set([B, C]));
    await settle();
    assert.deepEqual(open(), [B, C]);
    assert.equal(opened(B), 1, 'a kept id keeps its stream');
  });

  test('the view item changes nothing', async () => {
    const { views, open, opened, openOf } = setup();
    views.set(new Set([A]));
    await settle();

    openOf(A).push({ kind: 'viewing', threadId: A });
    await settle();

    assert.deepEqual(open(), [A]);
    assert.equal(opened(A), 1);
  });

  for (const code of ['unavailable', 'disconnected'] as const) {
    test(`a silent ${code} end opens the view again once the connection reports connected`, async () => {
      const { views, connection, open, openOf } = setup();
      views.set(new Set([A]));
      await settle();

      connection.current = 'disconnected';
      openOf(A).end(ended(code));
      await settle();
      assert.deepEqual(open(), []);

      connection.report('connected');
      await settle();
      assert.deepEqual(open(), [A]);
    });
  }

  test('a generation_lost end is opened again by the client, without the connection or the delay', async () => {
    const { views, open, opened, openOf, fireTimers } = setup();
    views.set(new Set([A]));
    await settle();

    openOf(A).end(ended('generation_lost', 'Generation 1 exited.'));
    await until(() => opened(A) === 2, 'the reopened view');

    assert.deepEqual(open(), [A]);
    fireTimers();
    await settle();
    assert.equal(opened(A), 2, 'the view is not opened a third time');
  });

  test('a silent end while the connection stays up opens the view again after the delay', async () => {
    const { views, open, openOf, fireTimers } = setup();
    views.set(new Set([A]));
    await settle();

    openOf(A).end(ended('unavailable', 'the runtime drains'));
    await settle();
    assert.deepEqual(open(), []);

    fireTimers();
    await settle();
    assert.deepEqual(open(), [A]);
  });

  test('a not_found end drops the id until the next set names it', async () => {
    const { views, connection, open, openOf, fireTimers } = setup();
    views.set(new Set([A]));
    await settle();

    openOf(A).end(ended('not_found', 'no such Thread'));
    await settle();
    connection.report('disconnected');
    connection.report('connected');
    fireTimers();
    await settle();
    assert.deepEqual(open(), []);

    views.set(new Set([A]));
    await settle();
    assert.deepEqual(open(), [A]);
  });

  test('close ends every view, and a later set follows again', async () => {
    const { views, connection, open, fireTimers } = setup();
    views.set(new Set([A, B]));
    await settle();

    views.close();
    await settle();
    assert.deepEqual(open(), []);
    connection.report('disconnected');
    connection.report('connected');
    fireTimers();
    await settle();
    assert.deepEqual(open(), []);
    views.close();

    views.set(new Set([A]));
    await settle();
    assert.deepEqual(open(), [A]);
  });

  test('a view that ends silently after close is not opened again', async () => {
    const { views, open, openOf, fireTimers } = setup();
    views.set(new Set([A]));
    await settle();
    const stream = openOf(A);

    views.close();
    stream.end(ended('unavailable', 'late end'));
    fireTimers();
    await settle();

    assert.deepEqual(open(), []);
  });
});

// T3.9: view of runtime.records/v1, through the client part's activation ----

describe('view over ViewThread (T3.9)', () => {
  const threadId = '00000000-0000-4000-8000-000000000011';
  const other = '00000000-0000-4000-8000-000000000012';

  /** The runtime's client part activated over a fake host. */
  const activated = async (t: { after(run: () => unknown): void }) => {
    const fake = fakeViews();
    const window = fakeClientServices({
      bundleId: 'runtime',
      hostClients: fake.host.hostClients,
    });
    const cleanup = await activate({
      services: window.services,
    } as unknown as Parameters<typeof activate>[0]);
    t.after(async () => {
      if (typeof cleanup === 'function') await cleanup();
    });
    const provided = window.provided.find(
      ({ id }) => id === 'runtime.records/v1',
    );
    assert.ok(provided !== undefined);
    const call = <K extends keyof RuntimeRecords>(name: K) =>
      (
        provided.methods as Record<string, { execute(input: unknown): unknown }>
      )[name];
    const records = {
      view: (input: { readonly threadId: string }) =>
        call('view')?.execute(input) as Disposable,
      thread: (id: string) => call('thread')?.execute(id),
      subscribe: (listener: () => void) =>
        call('subscribe')?.execute(listener) as Disposable,
    };
    const streamsOf = (id: string) =>
      fake.views.open().filter(({ request }) => request.threadId === id);

    return { ...fake, window, records, streamsOf, cleanup };
  };

  test('the first view of a Thread opens one ViewThread stream and a second opens none', async (t) => {
    const { records, views, streamsOf } = await activated(t);

    records.view({ threadId });
    await settle();
    assert.equal(views.openings.length, 1);
    assert.equal(views.openings[0]?.request.threadId, threadId);

    records.view({ threadId });
    await settle();
    assert.equal(views.openings.length, 1);
    assert.equal(streamsOf(threadId).length, 1);
  });

  test('disposing one of two views keeps the stream, and disposing the last ends it', async (t) => {
    const { records, views, streamsOf } = await activated(t);
    const first = records.view({ threadId });
    const second = records.view({ threadId });
    await settle();

    first.dispose();
    await settle();
    assert.equal(streamsOf(threadId).length, 1);

    second.dispose();
    await settle();
    assert.equal(streamsOf(threadId).length, 0);
    assert.equal(views.openings.length, 1);
  });

  test('each Thread with a view held has its own stream', async (t) => {
    const { records, streamsOf } = await activated(t);

    records.view({ threadId });
    const second = records.view({ threadId: other });
    await settle();
    assert.equal(streamsOf(threadId).length, 1);
    assert.equal(streamsOf(other).length, 1);

    second.dispose();
    await settle();
    assert.equal(streamsOf(threadId).length, 1);
    assert.equal(streamsOf(other).length, 0);
  });

  test('a generation_lost end opens the stream again', async (t) => {
    const { records, views, streamsOf } = await activated(t);
    records.view({ threadId });
    await settle();
    const [stream] = views.openings;
    assert.ok(stream !== undefined);

    stream.end(ended('generation_lost', 'Generation 1 exited.'));
    await until(() => views.openings.length === 2, 'the reopened view');

    assert.equal(streamsOf(threadId).length, 1);
  });

  test('after a not_found end the next view opens the stream again', async (t) => {
    const { records, views, streamsOf } = await activated(t);
    records.view({ threadId });
    await settle();
    const [stream] = views.openings;
    assert.ok(stream !== undefined);

    stream.end(ended('not_found', 'no such Thread'));
    await settle();
    assert.equal(streamsOf(threadId).length, 0);

    records.view({ threadId });
    await settle();
    assert.equal(streamsOf(threadId).length, 1);
  });

  test('after a not_found end the next disposal that leaves a view held opens the stream again', async (t) => {
    const { records, views, streamsOf } = await activated(t);
    const first = records.view({ threadId });
    records.view({ threadId });
    await settle();
    const [stream] = views.openings;
    assert.ok(stream !== undefined);

    stream.end(ended('not_found', 'no such Thread'));
    await settle();
    assert.equal(streamsOf(threadId).length, 0);

    first.dispose();
    await settle();
    assert.equal(streamsOf(threadId).length, 1);
  });

  test('closing the client part ends every view', async (t) => {
    const { records, views, cleanup } = await activated(t);
    records.view({ threadId });
    await settle();
    assert.equal(views.open().length, 1);

    if (typeof cleanup === 'function') await cleanup();
    await settle();

    assert.equal(views.open().length, 0);
  });

  test('a view changes no read, calls no subscriber and calls no other host method', async (t) => {
    const { records, views, host, window } = await activated(t);
    let notices = 0;
    const subscription = records.subscribe(() => {
      notices += 1;
    });
    t.after(() => subscription.dispose());

    const held = records.view({ threadId });
    await settle();
    const [stream] = views.openings;
    assert.ok(stream !== undefined);
    stream.push({ kind: 'viewing', threadId });
    stream.end(ended('not_found', 'no such Thread'));
    held.dispose();
    await settle();

    assert.equal(notices, 0);
    assert.deepEqual(
      host.calls.map(({ method }) => method),
      ['doric.runtime.threads.v1.ThreadsService/ViewThread'],
    );
    assert.deepEqual(window.envelope, []);
    assert.equal(records.thread(threadId), undefined);
  });

  test('every view call carries the runtime part', async (t) => {
    const { records, host } = await activated(t);

    records.view({ threadId });
    await settle();

    assert.deepEqual(
      host.calls.map(({ part }) => part),
      ['runtime'],
    );
  });
});

// The fake itself is the generated client's: a direct call reaches it.
void test('the fake host serves ViewThread to the generated client', async () => {
  const fake = fakeViews();
  const client = createClient(
    ThreadsService,
    fake.host.hostClients.part('probe').transport,
  );
  const controller = new AbortController();
  const items: string[] = [];
  const reading = (async () => {
    for await (const item of client.viewThread(
      { threadId: A },
      { signal: controller.signal },
    ))
      items.push(item.threadId);
  })().catch(() => undefined);

  await until(() => fake.views.openings.length === 1, 'the opening');
  fake.openOf(A).push({ kind: 'viewing', threadId: A });
  await until(() => items.length === 1, 'the item');
  controller.abort();
  await reading;

  assert.deepEqual(items, [A]);
});
