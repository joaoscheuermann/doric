// `settings/v1` served by `core` over the router (S39a): the port of
// `../settings.test.ts` onto `createCoreServices` and `createTestRouter`.
// Values are `google.protobuf.Any`s of the code-built test messages.
//
// Settings JSON (coordinator decision 4 on S39 gap 5): a write stores the
// message's JSON with default-valued fields emitted, as 1.x rows hold them;
// a read ignores fields the message lacks; a never-written space answers the
// message's proto defaults (the empty message), because `settings/v1`'s
// registration (`RegisterRequest { id, message_type }`) carries no defaults.
// Today's kernel answers the zod schema's `.default(...)` values instead.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  create,
  type DescMessage,
  type JsonValue,
  type MessageInitShape,
  toJson,
} from '@bufbuild/protobuf';
import { type Any, anyPack, anyUnpack } from '@bufbuild/protobuf/wkt';
import { type Client, ConnectError } from '@connectrpc/connect';
import { fromConnectError } from 'bundle/contracts';
import {
  type SettingsEntry,
  SettingsService,
} from 'bundle/contracts/gen/doric/settings/v1/settings_pb.js';
import { createMemoryStore } from 'storage/memory';

import { type RoutedCore, serveCore, testMessages } from '../support/router.js';

const types = testMessages();

const messageOf = (typeName: string): DescMessage => {
  const desc = types.getMessage(typeName);

  assert.ok(desc !== undefined, typeName);

  return desc;
};

const Prefs = messageOf('notes.Prefs');
const Strict = messageOf('notes.Strict');

const prefs = (init: Record<string, unknown>): Any =>
  anyPack(Prefs, create(Prefs, init as MessageInitShape<typeof Prefs>));

const strict = (init: Record<string, unknown>): Any =>
  anyPack(Strict, create(Strict, init as MessageInitShape<typeof Strict>));

/** The JSON of the message `value` packs (protobuf-es defaults: zero fields omitted). */
const jsonOf = (value: Any | undefined): JsonValue => {
  assert.ok(value !== undefined, 'no value');

  const message = anyUnpack(value, types);

  assert.ok(message !== undefined, `cannot unpack ${value.typeUrl}`);

  return toJson(messageOf(message.$typeName), message);
};

const plain = (entry: SettingsEntry | undefined) => {
  assert.ok(entry !== undefined, 'no settings entry');

  return {
    value: jsonOf(entry.value),
    revision: entry.revision,
    version: entry.version,
    updatedAt: entry.updatedAt,
    generation: entry.generation,
  };
};

const rejectsWith = async (
  promise: Promise<unknown>,
  code: string,
  details?: Record<string, unknown>,
) => {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ConnectError, `not a ConnectError: ${error}`);

    const contract = fromConnectError(error);

    assert.equal(contract.code, code, error.message);

    if (details !== undefined) {
      assert.deepEqual(contract.details, details);
    }

    return true;
  });
};

const at = Date.UTC(2026, 9, 9, 12, 0, 0, 5);
const EPOCH = new Date(0).toISOString();

const notesProvides = ['notes.prefs/v1@1.2.0', 'notes.strict/v1@1.0.0'];

const served = (
  options: Parameters<typeof serveCore>[0] = {},
): Promise<RoutedCore> =>
  serveCore({
    bundles: { notes: notesProvides, other: [] },
    ...options,
  });

/** `notes`' settings client with both spaces registered. */
const registered = async (
  core: RoutedCore,
): Promise<Client<typeof SettingsService>> => {
  const settings = core.client(SettingsService, 'notes');

  await settings.register({ id: 'notes.prefs/v1', messageType: 'notes.Prefs' });
  await settings.register({
    id: 'notes.strict/v1',
    messageType: 'notes.Strict',
  });

  return settings;
};

void test("a space never written answers the message's proto defaults at revision 0; one whose empty message breaks its rules is settings_missing", async () => {
  const core = await served();

  try {
    const settings = await registered(core);

    // Pinned (decision 4): proto defaults, not a space default — the empty
    // `notes.Prefs`. Today's zod `.default(...)` values have no counterpart.
    assert.deepEqual(
      jsonOf((await settings.get({ id: 'notes.prefs/v1' })).value),
      {},
    );
    assert.deepEqual(
      plain((await settings.entry({ id: 'notes.prefs/v1' })).settingsEntry),
      {
        value: {},
        revision: 0,
        version: '1.2.0',
        updatedAt: EPOCH,
        generation: 0,
      },
    );

    await rejectsWith(settings.get({ id: 'notes.strict/v1' }), 'settings_missing');
    await rejectsWith(
      settings.entry({ id: 'notes.strict/v1' }),
      'settings_missing',
    );
  } finally {
    await core.close();
  }
});

void test('each Set adds one to the space revision and to the global generation', async () => {
  const core = await served({ now: () => at });

  try {
    const settings = await registered(core);
    const first = await settings.set({
      id: 'notes.prefs/v1',
      value: prefs({ theme: 'light' }),
    });

    assert.deepEqual(plain(first.settingsEntry), {
      value: { theme: 'light' },
      revision: 1,
      version: '1.2.0',
      updatedAt: '2026-10-09T12:00:00.005Z',
      generation: 1,
    });

    const second = await settings.set({
      id: 'notes.prefs/v1',
      value: prefs({ size: 3 }),
    });

    assert.equal(second.settingsEntry?.revision, 2);
    assert.equal(second.settingsEntry?.generation, 2);
    assert.deepEqual(jsonOf(second.settingsEntry?.value), { size: 3 });

    const elsewhere = await settings.set({
      id: 'notes.strict/v1',
      value: strict({ name: 'n' }),
    });

    assert.equal(elsewhere.settingsEntry?.revision, 1);
    assert.equal(elsewhere.settingsEntry?.generation, 3);

    assert.deepEqual(
      plain((await settings.entry({ id: 'notes.prefs/v1' })).settingsEntry),
      plain(second.settingsEntry),
    );
    assert.deepEqual(
      jsonOf((await settings.get({ id: 'notes.strict/v1' })).value),
      { name: 'n' },
    );
  } finally {
    await core.close();
  }
});

void test('a written space survives a restart, stored as the JSON of its message with default fields emitted', async () => {
  const store = createMemoryStore();
  const before = await served({ store, now: () => at });
  let written: ReturnType<typeof plain>;

  try {
    const settings = await registered(before);

    await settings.set({
      id: 'notes.prefs/v1',
      value: prefs({ theme: 'light' }),
    });
    written = plain(
      (
        await settings.set({
          id: 'notes.prefs/v1',
          value: prefs({ size: 2 }),
        })
      ).settingsEntry,
    );
  } finally {
    await before.close();
  }

  const after = await served({ store });

  try {
    const settings = await registered(after);

    assert.deepEqual(
      plain((await settings.entry({ id: 'notes.prefs/v1' })).settingsEntry),
      written,
    );

    // The row core wrote: `theme` holds its default and is still written.
    const row = await after
      .storage('doric', 0)
      .get({ type: 'core.settings/v1', id: 'notes.prefs/v1' });

    assert.deepEqual(row?.value, {
      value: { theme: '', size: 2 },
      version: '1.2.0',
      updatedAt: '2026-10-09T12:00:00.005Z',
      generation: 2,
    });

    const next = await settings.set({
      id: 'notes.strict/v1',
      value: strict({ name: 'n' }),
    });

    assert.equal(next.settingsEntry?.generation, 3);
  } finally {
    await after.close();
  }
});

void test('a stored row with a field the message lacks is read as the message (1.x rows)', async () => {
  const store = createMemoryStore();
  const before = await served({ store });

  try {
    const settings = await registered(before);

    await settings.set({
      id: 'notes.prefs/v1',
      value: prefs({ theme: 'a' }),
    });
    await before.storage('doric', 0).commit({
      expect: [{ type: 'core.settings/v1', id: 'notes.prefs/v1', revision: 1 }],
      put: [
        {
          type: 'core.settings/v1',
          id: 'notes.prefs/v1',
          value: {
            value: { theme: 'x', legacy: true },
            version: '1.2.0',
            updatedAt: EPOCH,
            generation: 1,
          },
        },
      ],
    });
  } finally {
    await before.close();
  }

  const after = await served({ store });

  try {
    const settings = await registered(after);

    assert.deepEqual(
      jsonOf((await settings.get({ id: 'notes.prefs/v1' })).value),
      { theme: 'x' },
    );
  } finally {
    await after.close();
  }
});

void test('an expected revision that does not match refuses the write with settings_conflict', async () => {
  const core = await served();

  try {
    const settings = await registered(core);

    await settings.set({
      id: 'notes.prefs/v1',
      value: prefs({ theme: 'light' }),
    });

    await rejectsWith(
      settings.set({
        id: 'notes.prefs/v1',
        value: prefs({ theme: 'x' }),
        expectedRevision: 0,
      }),
      'settings_conflict',
      { settings: 'notes.prefs/v1', expected: 0, actual: 1 },
    );

    const unchanged = plain(
      (await settings.entry({ id: 'notes.prefs/v1' })).settingsEntry,
    );

    assert.equal(unchanged.revision, 1);
    assert.deepEqual(unchanged.value, { theme: 'light' });

    const matched = await settings.set({
      id: 'notes.prefs/v1',
      value: prefs({ theme: 'x' }),
      expectedRevision: 1,
    });

    assert.equal(matched.settingsEntry?.revision, 2);
    assert.deepEqual(
      jsonOf((await settings.get({ id: 'notes.prefs/v1' })).value),
      { theme: 'x' },
    );
  } finally {
    await core.close();
  }
});

void test("a value its rules refuse, or an Any of another message, is invalid_input and changes nothing", async () => {
  const core = await served();

  try {
    const settings = await registered(core);

    await settings.set({
      id: 'notes.prefs/v1',
      value: prefs({ theme: 'light' }),
    });

    await rejectsWith(
      settings.set({ id: 'notes.prefs/v1', value: prefs({ size: 0 }) }),
      'invalid_input',
    );
    await rejectsWith(
      settings.set({ id: 'notes.prefs/v1', value: strict({ name: 'n' }) }),
      'invalid_input',
    );

    const entry = plain(
      (await settings.entry({ id: 'notes.prefs/v1' })).settingsEntry,
    );

    assert.equal(entry.revision, 1);
    assert.equal(entry.generation, 1);
    assert.deepEqual(entry.value, { theme: 'light' });
  } finally {
    await core.close();
  }
});

void test('spaces are registered by the bundle their namespace names, once, from provides, with a message carrying their id', async () => {
  const core = await served({
    bundles: { notes: ['notes.prefs/v1@1.2.0'], other: [] },
  });

  try {
    const settings = core.client(SettingsService, 'notes');

    await rejectsWith(settings.get({ id: 'notes.prefs/v1' }), 'unknown_settings');
    await rejectsWith(
      settings.set({ id: 'notes.prefs/v1', value: prefs({}) }),
      'unknown_settings',
    );

    await rejectsWith(
      core
        .client(SettingsService, 'other')
        .register({ id: 'notes.prefs/v1', messageType: 'notes.Prefs' }),
      'not_owner',
    );
    await rejectsWith(
      settings.register({ id: 'notes.strict/v1', messageType: 'notes.Strict' }),
      'undeclared_provide',
    );
    await rejectsWith(
      settings.register({ id: 'notes.prefs/v1', messageType: 'notes.Missing' }),
      'invalid_input',
    );
    await rejectsWith(
      settings.register({ id: 'notes.prefs/v1', messageType: 'notes.Strict' }),
      'invalid_input',
    );

    const { registrationId } = await settings.register({
      id: 'notes.prefs/v1',
      messageType: 'notes.Prefs',
    });

    assert.notEqual(registrationId, '');
    await rejectsWith(
      settings.register({ id: 'notes.prefs/v1', messageType: 'notes.Prefs' }),
      'registration_conflict',
    );
    assert.deepEqual(
      jsonOf((await settings.get({ id: 'notes.prefs/v1' })).value),
      {},
    );
  } finally {
    await core.close();
  }
});

void test('Watch yields the present entry first, then one entry per Set; a cancelled Watch does not fail the next Set', async () => {
  const core = await served();

  try {
    const settings = await registered(core);

    await settings.set({
      id: 'notes.prefs/v1',
      value: prefs({ theme: 'light' }),
    });

    const written = new AbortController();
    const watched = settings
      .watch({ id: 'notes.prefs/v1' }, { signal: written.signal })
      [Symbol.asyncIterator]();

    const present = await watched.next();

    assert.equal(present.done, false);
    assert.deepEqual(
      [
        present.value.settingsEntry?.revision,
        jsonOf(present.value.settingsEntry?.value),
      ],
      [1, { theme: 'light' }],
    );

    await settings.set({ id: 'notes.prefs/v1', value: prefs({ size: 2 }) });
    await settings.set({ id: 'notes.strict/v1', value: strict({ name: 'n' }) });
    await settings.set({ id: 'notes.prefs/v1', value: prefs({ size: 3 }) });

    const seen: unknown[] = [];

    for (let index = 0; index < 2; index += 1) {
      const item = await watched.next();

      assert.equal(item.done, false);
      seen.push([
        item.value.settingsEntry?.revision,
        jsonOf(item.value.settingsEntry?.value),
      ]);
    }

    assert.deepEqual(seen, [
      [2, { size: 2 }],
      [3, { size: 3 }],
    ]);

    written.abort();
    await watched.next().catch(() => undefined);

    const after = await settings.set({
      id: 'notes.prefs/v1',
      value: prefs({ theme: 'dark' }),
    });

    assert.equal(after.settingsEntry?.revision, 4);
  } finally {
    await core.close();
  }
});

void test('Watch on a never-written space starts with its first write; on an unregistered id it is unknown_settings', async () => {
  const core = await served();

  try {
    const settings = await registered(core);
    const stop = new AbortController();
    const watched = settings
      .watch({ id: 'notes.prefs/v1' }, { signal: stop.signal })
      [Symbol.asyncIterator]();
    const first = watched.next();

    // Whether the stream opened before or after this write, its first item
    // is this write's entry: there is no present entry before it.
    await settings.set({
      id: 'notes.prefs/v1',
      value: prefs({ theme: 'light' }),
    });

    const item = await first;

    assert.equal(item.done, false);
    assert.equal(item.value.settingsEntry?.revision, 1);
    assert.deepEqual(jsonOf(item.value.settingsEntry?.value), {
      theme: 'light',
    });

    stop.abort();
    await watched.next().catch(() => undefined);

    const unknown = async () => {
      for await (const _ of core
        .client(SettingsService, 'other')
        .watch({ id: 'other.prefs/v1' })) {
        // An item would be a failure: none is expected.
        assert.fail('an unregistered space answered an item');
      }
    };

    await rejectsWith(unknown(), 'unknown_settings');
  } finally {
    await core.close();
  }
});

void test("after Unregister the space is unknown_settings; an unknown id or another bundle's id is a no-op", async () => {
  const core = await served();

  try {
    const settings = core.client(SettingsService, 'notes');
    const { registrationId } = await settings.register({
      id: 'notes.prefs/v1',
      messageType: 'notes.Prefs',
    });

    await settings.unregister({ registrationId: 'never-answered' });
    await core
      .client(SettingsService, 'other')
      .unregister({ registrationId });

    assert.deepEqual(
      jsonOf((await settings.get({ id: 'notes.prefs/v1' })).value),
      {},
    );

    await settings.unregister({ registrationId });
    await rejectsWith(settings.get({ id: 'notes.prefs/v1' }), 'unknown_settings');

    // Forgotten: a second Unregister is a no-op too.
    await settings.unregister({ registrationId });
  } finally {
    await core.close();
  }
});

void test("activation reaches no backend; the first settings call defines core's types, declared on first use", async () => {
  const core = await served();

  try {
    assert.deepEqual([...core.backendCalls], []);

    const settings = await registered(core);

    await settings.get({ id: 'notes.prefs/v1' });
    assert.ok(core.store.types.has('core.settings/v1'));

    await settings.set({
      id: 'notes.prefs/v1',
      value: prefs({ theme: 'light' }),
    });
    assert.ok(core.store.types.has('core.settings-generation/v1'));

    // `core.settings/v1` is core's: another bundle does not read its rows.
    await assert.rejects(
      core
        .storage('notes')
        .get({ type: 'core.settings/v1', id: 'notes.prefs/v1' }),
      { code: 'not_owner' },
    );
  } finally {
    await core.close();
  }
});

void test("spaces follow the router's stamp: each generation registers its own; a value written in one is watched and read in each that registered it", async () => {
  const core = await served();

  try {
    const first = core.client(SettingsService, 'notes', { generation: 1 });
    const second = core.client(SettingsService, 'notes', { generation: 2 });
    const space = { id: 'notes.prefs/v1', messageType: 'notes.Prefs' };
    const { registrationId } = await first.register(space);

    await second.register(space);
    await rejectsWith(second.register(space), 'registration_conflict');

    const stop = new AbortController();
    const watched = [first, second].map((client) =>
      client
        .watch({ id: 'notes.prefs/v1' }, { signal: stop.signal })
        [Symbol.asyncIterator](),
    );
    const pending = watched.map((items) => items.next());

    // Whether each stream opened before or after this write, its first item
    // is this write's entry: there is no present entry before it.
    await second.set({ id: 'notes.prefs/v1', value: prefs({ size: 3 }) });

    const heard = await Promise.all(pending);

    stop.abort();
    await Promise.all(
      watched.map((items) => items.next().catch(() => undefined)),
    );
    assert.deepEqual(
      heard.map((item) => jsonOf(item.value?.settingsEntry?.value)),
      [{ size: 3 }, { size: 3 }],
    );

    await first.unregister({ registrationId });
    assert.deepEqual(
      jsonOf((await second.get({ id: 'notes.prefs/v1' })).value),
      { size: 3 },
    );
    await rejectsWith(first.get({ id: 'notes.prefs/v1' }), 'unknown_settings');
  } finally {
    await core.close();
  }
});

void test('an InstanceGone disposes the spaces that instance registered; their entries stay', async () => {
  const store = createMemoryStore();
  const core = await served({ store });

  try {
    const settings = await registered(core);

    await settings.set({
      id: 'notes.prefs/v1',
      value: prefs({ theme: 'light' }),
    });

    core.instanceGone({ bundleId: 'notes', generation: 1 });

    await rejectsWith(settings.get({ id: 'notes.prefs/v1' }), 'unknown_settings');

    await settings.register({ id: 'notes.prefs/v1', messageType: 'notes.Prefs' });
    assert.deepEqual(
      jsonOf((await settings.get({ id: 'notes.prefs/v1' })).value),
      { theme: 'light' },
    );
  } finally {
    await core.close();
  }
});
