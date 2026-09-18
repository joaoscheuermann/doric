import assert from 'node:assert/strict';
import test from 'node:test';

import { createConfigStore } from '../src/lib/config-store.js';
import { createDatabase } from '../src/lib/database.js';
import { createSessionStore } from '../src/lib/sessions.js';

const connectionString = process.env.DORIC_TEST_DATABASE_URL;

integrationTest(
  'persists the public session shape without private conversation fields',
  async ({ configs, sessions }) => {
    const record = await sessions.create(await configs.load());

    assert.deepEqual(record.messages, []);

    assert.equal('prompt' in record.session, false);

    assert.equal('result' in record.session, false);
  },
);

integrationTest(
  'assigns contiguous sequences to concurrently persisted events',
  async ({ configs, sessions }) => {
    const record = await sessions.create(await configs.load());
    const accepted = await sessions.acceptPrompt(record.session.id, promptId);

    assert.equal(accepted.status, 'accepted');

    await Promise.all([
      sessions.appendEvent(record.session.id, promptId, {
        type: 'reasoning.delta',
        delta: 'one',
      }),
      sessions.appendEvent(record.session.id, promptId, {
        type: 'response.started',
        model: 'test',
      }),
    ]);

    assert.deepEqual(
      (await sessions.eventsAfter(record.session.id, 0)).map(
        ({ sequence }) => sequence,
      ),
      [1, 2, 3],
    );
  },
);

integrationTest(
  'persists provider-ready messages when a prompt finishes',
  async ({ configs, sessions }) => {
    const record = await sessions.create(await configs.load());

    assert.equal((await sessions.markReady(record.session.id))?.state, 'ready');

    assert.equal(
      (await sessions.markRunning(record.session.id))?.state,
      'running',
    );

    const messages = [
      { role: 'user' as const, content: 'first' },
      {
        role: 'assistant' as const,
        content: 'done',
        replay: [{ type: 'reasoning', encrypted_content: 'opaque' }],
      },
    ];

    assert.equal(
      (await sessions.finishPrompt(record.session.id, messages))?.state,
      'ready',
    );

    assert.deepEqual(
      (await sessions.find(record.session.id))?.messages,
      messages,
    );
  },
);

integrationTest(
  'captures the active configuration snapshot for each new session',
  async ({ configs, sessions }) => {
    const initial = await configs.load();
    const first = await sessions.create(initial);
    const replacementInput = structuredClone(initial.configuration);

    replacementInput.models.execution.model = 'replacement-executor';

    const replacement = await configs.replace(replacementInput);
    const second = await sessions.create(replacement);

    assert.equal(first.session.configRevision, initial.revision);

    assert.equal(second.session.configRevision, replacement.revision);

    assert.equal(
      (await sessions.find(first.session.id))?.snapshot.revision,
      initial.revision,
    );

    assert.equal(
      (await sessions.find(second.session.id))?.snapshot.configuration.models
        .execution.model,
      'replacement-executor',
    );

    assert.equal((await configs.load()).revision, replacement.revision);
  },
);

integrationTest(
  'cascades persisted events when a terminal session is deleted',
  async ({ configs, sessions }) => {
    const record = await sessions.create(await configs.load());

    assert.equal(
      (await sessions.acceptPrompt(record.session.id, promptId)).status,
      'accepted',
    );

    assert.equal(
      (await sessions.requestCancellation(record.session.id))?.state,
      'cancelling',
    );

    assert.equal(
      (await sessions.finish(record.session.id, 'cancelled'))?.state,
      'cancelled',
    );

    assert.equal(await sessions.delete(record.session.id), 'deleted');

    assert.deepEqual(await sessions.eventsAfter(record.session.id, 0), []);
  },
);

integrationTest(
  'fails interrupted sessions without changing persisted configuration',
  async ({ configs, sessions }) => {
    const initial = await configs.load();
    const record = await sessions.create(initial);

    assert.equal(await sessions.reconcile(), 1);

    const interrupted = await sessions.find(record.session.id);

    assert.equal(interrupted?.session.state, 'failed');

    assert.equal(interrupted?.session.errorCode, 'process_interrupted');

    assert.deepEqual(await configs.load(), initial);
  },
);

function integrationTest(
  name: string,
  run: (stores: {
    configs: ReturnType<typeof createConfigStore>;
    sessions: ReturnType<typeof createSessionStore>;
  }) => Promise<void>,
) {
  test(name, { skip: connectionString === undefined }, async () => {
    assert.ok(connectionString);

    const database = createDatabase(connectionString);

    try {
      await database.session.deleteMany();

      await run({
        configs: createConfigStore(database),
        sessions: createSessionStore(database),
      });
    } finally {
      await database.session.deleteMany();

      await database.$disconnect();
    }
  });
}

const promptId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1602';
