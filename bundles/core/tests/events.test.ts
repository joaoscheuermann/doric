import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  defineEvent,
  type Events,
  EventsV1,
  SecretsV1,
  StorageV1,
  threadEventEnvelopeSchema,
  threadEventsStream,
} from 'bundle/contracts';
import { z } from 'zod';

import { boot, core, probe } from './support/host.js';

// D-E and E-6: the events/v1 facade (stage 2+3 design §5.5).

const sent = defineEvent({
  type: 'notify.sent/v1',
  payload: z.object({ text: z.string(), detail: z.unknown().optional() }),
});

const scope = { projectId: 'p-1', threadId: 't-1', promptId: 'q-1' };

/** A bundle that hands its events/v1 stub to the test. */
const user = (id: string, options: { readonly register?: boolean } = {}) => {
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
      },
    }),
    get events(): Events {
      assert.ok(events);

      return events;
    },
  };
};

const readThread = async (
  host: Awaited<ReturnType<typeof boot>>,
  threadId: string,
) =>
  await host.platform.services.use(StorageV1).read({
    stream: threadEventsStream(threadId),
    afterSequence: 0,
    limit: 100,
  });

void test('an appended event lands in the Thread log of its scope, redacted and storable', async () => {
  const notify = user('notify', { register: true });
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

    const page = await readThread(host, 't-1');

    assert.equal(page.lastSequence, 1);

    const [entry] = page.entries;

    assert.ok(entry);
    assert.ok(!Number.isNaN(Date.parse(entry.createdAt)));
    assert.deepEqual(threadEventEnvelopeSchema.parse(entry.value), {
      projectId: 'p-1',
      threadId: 't-1',
      promptId: 'q-1',
      type: 'notify.sent/v1',
      event: {
        type: 'notify.sent/v1',
        text: '[REDACTED] then [REDACTED]\uFFFD',
        detail: { nested: ['[REDACTED]'] },
      },
    });
  } finally {
    await host.close();
  }
});

void test('an append needs a project, Thread and prompt in its scope', async () => {
  const notify = user('notify', { register: true });
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
    assert.equal((await readThread(host, 't-1')).lastSequence, 0);
  } finally {
    await host.close();
  }
});

void test('only the owner appends a registered event, and only a valid payload', async () => {
  const notify = user('notify');
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
    assert.equal((await readThread(host, 't-1')).lastSequence, 0);

    await notify.events.append(sent, { text: 'ok' }, call());
    assert.equal((await readThread(host, 't-1')).lastSequence, 1);
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

// E-6: before stage 5, REST and Socket.IO read only `thread_event`, so an event
// appended through events/v1 would be durable but invisible. No bundle the
// host ships may provide an event contract until the runtime reads the stream.
void test('no bundle of the shipped host composition provides an event contract', async () => {
  const composition = JSON.parse(
    await readFile('agents/doric/composition.json', 'utf8'),
  ) as { readonly enabled: readonly string[] };

  for (const id of composition.enabled) {
    const published = JSON.parse(
      await readFile(`bundles/${id}/contracts.published.json`, 'utf8'),
    ) as { readonly contracts: readonly { id: string; kind: string }[] };
    const events = published.contracts
      .filter(({ kind }) => kind === 'event')
      .map((contract) => contract.id);

    assert.deepEqual(events, [], `bundle ${id} provides events`);
  }
});
