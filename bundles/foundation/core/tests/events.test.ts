import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  defineEvent,
  type EventSinkSpec,
  type Events,
  EventsV1,
  SecretsV1,
  StorageV1,
} from 'bundle/contracts';
import { z } from 'zod';

import { boot, core, probe } from './support/host.js';

// D-E and E-6: the events/v1 facade (stage 2+3 design §5.5), and its event
// sink (M5): the provider's owner names where the rows go, and the core
// writes them without knowing any stream name or scope key of a bundle.

const sent = defineEvent({
  type: 'notify.sent/v1',
  payload: z.object({ text: z.string(), detail: z.unknown().optional() }),
});

const scope = { projectId: 'p-1', threadId: 't-1', promptId: 'q-1' };

/** The sink a bundle registers in the same shape the runtime uses. */
const sinkSpec: EventSinkSpec = {
  scopeKeys: ['projectId', 'threadId', 'promptId'],
  stream: 'notify.thread-events/{threadId}',
  scopeDescription: 'a project, a Thread and a prompt',
};

/** A bundle that hands its events/v1 stub to the test. */
const user = (
  id: string,
  options: {
    readonly register?: boolean;
    readonly sink?: EventSinkSpec;
  } = {},
) => {
  let events: Events | undefined;

  return {
    bundle: probe(id, {
      requires: ['events/v1@^1.0.0'],
      provides: id === 'notify' ? [['notify.sent/v1', 'event']] : [],
      activate: ({ services }) => {
        events = services.use(EventsV1);

        if (options.register === true) {
          events.register(sent);
        }

        if (options.sink !== undefined) {
          events.sink(options.sink);
        }
      },
    }),
    get events(): Events {
      assert.ok(events);

      return events;
    },
  };
};

const readStream = async (
  host: Awaited<ReturnType<typeof boot>>,
  stream: string,
) =>
  await host.platform.services.use(StorageV1).read({
    stream,
    afterSequence: 0,
    limit: 100,
  });

void test('an appended event lands in its sink stream, redacted and storable, byte for byte', async () => {
  const notify = user('notify', { register: true, sink: sinkSpec });
  const host = await boot([await core(), notify.bundle], {
    memory: {
      secrets: {
        rows: [
          { id: 'c-1', kind: 'API_TOKEN', name: 'key', secret: 'sk-stored' },
        ],
      },
    },
  });

  try {
    await host.platform.services.use(SecretsV1).list();
    host.platform.services.use(SecretsV1).view().addRedaction('ghp-added');

    await notify.events.append(
      sent,
      {
        text: 'sk-stored then ghp-added\u0000',
        detail: { nested: ['sk-stored'] },
      },
      host.platform.call({ scope }),
    );

    const page = await readStream(host, 'notify.thread-events/t-1');

    assert.equal(page.lastSequence, 1);

    const [entry] = page.entries;

    assert.ok(entry);
    assert.ok(!Number.isNaN(Date.parse(entry.createdAt)));
    // The row as the stage-2 facade stored it: scope keys in sink order, then
    // the type and the redacted body. Captured from the pre-sink facade.
    assert.equal(
      JSON.stringify(entry.value),
      '{"projectId":"p-1","threadId":"t-1","promptId":"q-1","type":"notify.sent/v1","event":{"type":"notify.sent/v1","text":"[REDACTED] then [REDACTED]�","detail":{"nested":["[REDACTED]"]}}}',
    );
  } finally {
    await host.close();
  }
});

void test('an append needs every key of its sink in the call scope', async () => {
  const notify = user('notify', { register: true, sink: sinkSpec });
  const host = await boot([await core(), notify.bundle]);

  try {
    await assert.rejects(notify.events.append(sent, { text: 'x' }), {
      code: 'invalid_scope',
    });
    await assert.rejects(
      notify.events.append(
        sent,
        { text: 'x' },
        host.platform.call({ scope: { projectId: 'p-1', threadId: 't-1' } }),
      ),
      { code: 'invalid_scope' },
    );
    assert.equal(
      (await readStream(host, 'notify.thread-events/t-1')).lastSequence,
      0,
    );
  } finally {
    await host.close();
  }
});

void test('an append without any sink registered is refused as an invalid scope', async () => {
  const notify = user('notify', { register: true });
  const host = await boot([await core(), notify.bundle]);

  try {
    await assert.rejects(
      notify.events.append(sent, { text: 'x' }, host.platform.call({ scope })),
      { code: 'invalid_scope' },
    );
  } finally {
    await host.close();
  }
});

void test('the row keeps only the keys its sink names, in the sink order', async () => {
  const notify = user('notify', {
    register: true,
    sink: {
      scopeKeys: ['promptId', 'threadId'],
      stream: 'notify.by-thread/{threadId}',
    },
  });
  const host = await boot([await core(), notify.bundle]);

  try {
    await notify.events.append(
      sent,
      { text: 'ok' },
      host.platform.call({ scope }),
    );

    const page = await readStream(host, 'notify.by-thread/t-1');

    assert.equal(
      JSON.stringify(page.entries[0]?.value),
      '{"promptId":"q-1","threadId":"t-1","type":"notify.sent/v1","event":{"type":"notify.sent/v1","text":"ok"}}',
    );
  } finally {
    await host.close();
  }
});

void test('only the owner appends a registered event, and only a valid payload', async () => {
  const notify = user('notify', { sink: sinkSpec });
  const other = user('other');
  const host = await boot([await core(), notify.bundle, other.bundle]);
  const call = () => host.platform.call({ scope });

  try {
    await assert.rejects(notify.events.append(sent, { text: 'x' }, call()), {
      code: 'unknown_event',
    });

    notify.events.register(sent);

    await assert.rejects(other.events.append(sent, { text: 'x' }, call()), {
      code: 'not_owner',
    });
    await assert.rejects(
      notify.events.append(sent, { text: 1 } as never, call()),
      {
        code: 'invalid_input',
      },
    );
    assert.equal(
      (await readStream(host, 'notify.thread-events/t-1')).lastSequence,
      0,
    );

    await notify.events.append(sent, { text: 'ok' }, call());
    assert.equal(
      (await readStream(host, 'notify.thread-events/t-1')).lastSequence,
      1,
    );
  } finally {
    await host.close();
  }
});

void test('an event is registered once, by the bundle its namespace names, without a payload "type"', async () => {
  const notify = user('notify');
  const host = await boot([await core(), notify.bundle]);

  try {
    assert.throws(
      () =>
        notify.events.register(
          defineEvent({ type: 'git.pushed/v1', payload: z.object({}) }),
        ),
      { code: 'not_owner' },
    );
    assert.throws(
      () =>
        notify.events.register(
          defineEvent({ type: 'notify.undeclared/v1', payload: z.object({}) }),
        ),
      { code: 'undeclared_provide' },
    );
    assert.throws(
      () =>
        notify.events.register(
          defineEvent({
            type: 'notify.sent/v1',
            payload: z.object({ type: z.string() }),
          }),
        ),
      { code: 'invalid_input' },
    );

    notify.events.register(sent);
    assert.throws(() => notify.events.register(sent), {
      code: 'registration_conflict',
    });
  } finally {
    await host.close();
  }
});

void test('one event sink per events/v1 provider, and only a stream its owner names', async () => {
  const notify = user('notify');
  const host = await boot([await core(), notify.bundle]);

  try {
    assert.throws(
      () =>
        notify.events.sink({
          scopeKeys: ['threadId'],
          stream: 'other.x/{threadId}',
        }),
      { code: 'not_owner' },
    );

    const registered = notify.events.sink(sinkSpec);

    assert.throws(() => notify.events.sink(sinkSpec), {
      code: 'registration_conflict',
    });

    registered.dispose();
    notify.events.sink(sinkSpec);
  } finally {
    await host.close();
  }
});

void test('a sink whose owner segment is a placeholder writes only the streams of its owner, row by row', async () => {
  const xSent = defineEvent({
    type: 'x.sent/v1',
    payload: z.object({ text: z.string() }),
  });
  // The owner is filled by the call's projectId, so the sample check passes
  // for the bundle named "x" alone; each row must still name its own owner.
  const ownerSink: EventSinkSpec = {
    scopeKeys: ['projectId', 'threadId'],
    stream: '{projectId}.x/{threadId}',
  };
  let events: Events | undefined;
  const intruder = probe('x', {
    requires: ['events/v1@^1.0.0'],
    provides: [['x.sent/v1', 'event']],
    activate: ({ services }) => {
      events = services.use(EventsV1);
      events.register(xSent);
      events.sink(ownerSink);
    },
  });
  const host = await boot([await core(), intruder]);

  try {
    assert.ok(events);

    await assert.rejects(
      events.append(
        xSent,
        { text: 'x' },
        host.platform.call({
          scope: { projectId: 'runtime', threadId: 't-1' },
        }),
      ),
      { code: 'not_owner' },
    );
    assert.equal(
      (await readStream(host, 'runtime.x/t-1')).lastSequence,
      0,
      'a row names no stream of another owner',
    );

    await events.append(
      xSent,
      { text: 'ok' },
      host.platform.call({ scope: { projectId: 'x', threadId: 't-1' } }),
    );
    assert.equal((await readStream(host, 'x.x/t-1')).lastSequence, 1);
  } finally {
    await host.close();
  }
});

// E-6: before stage 5, REST and Socket.IO read only `thread_event`, so an event
// appended through events/v1 would be durable but invisible. From stage 5 the
// runtime owns the Thread streams and writes its one event contract
// (`runtime.prompt-finished/v1`, X-7) itself; an append by another bundle
// would still bypass the runtime aggregate (G-7), so no other bundle the host
// ships may provide one through stage 7.
void test('no bundle of the shipped host composition but the runtime provides an event contract', async () => {
  const composition = JSON.parse(
    await readFile('agents/doric/composition.json', 'utf8'),
  ) as { readonly enabled: readonly string[] };

  const descriptors = new Map<string, string>();
  for (const group of await readdir('bundles', { withFileTypes: true })) {
    if (!group.isDirectory()) continue;
    for (const name of await readdir(`bundles/${group.name}`)) {
      if (!composition.enabled.includes(name)) continue;
      descriptors.set(
        name,
        `bundles/${group.name}/${name}/dist/contracts.json`,
      );
    }
  }

  for (const id of composition.enabled) {
    // The descriptor the build of each shipped bundle writes; the build no
    // longer keeps a committed copy (contracts.published.json is gone). The
    // core test target builds every enabled bundle first (dependsOn in
    // bundles/foundation/core/project.json), so these files exist when this runs.
    const descriptor = descriptors.get(id);
    assert.ok(descriptor, `built descriptor for enabled bundle ${id}`);
    const built = JSON.parse(await readFile(descriptor, 'utf8')) as {
      readonly contracts: readonly { id: string; kind: string }[];
    };
    const events = built.contracts
      .filter(({ kind }) => kind === 'event')
      .map((contract) => contract.id);

    assert.deepEqual(
      events,
      id === 'runtime' ? ['runtime.prompt-finished/v1'] : [],
      `bundle ${id} provides events`,
    );
  }
});
