import assert from 'node:assert/strict';
import test from 'node:test';

import type { EmbeddedBundle } from 'bundle';
import {
  defineMethod,
  defineService,
  defineSettings,
  type HostContext,
  type Settings,
  SettingsV1,
  StorageV1,
  type StoredDocument,
  storageMethods,
} from 'bundle/contracts';
import { memoryFoundation } from 'storage/memory';
import { z } from 'zod';

import { boot, core, probe, reasonCodes, states } from './support/host.js';

// D-F: the core runs over the chosen backends, and its facades reach each
// other only through contracts (stage 2+3 design §5.1).

void test('the core activates over the memory backends chosen in providers', async () => {
  const host = await boot([await core()]);

  try {
    assert.equal(host.platform.mode, 'normal');
    assert.deepEqual(states(host.platform), {
      core: 'active',
      memory: 'active',
    });

    const provided = new Map(
      host.platform
        .catalog()
        .contracts.map(({ id, providers }) => [id, providers[0]?.bundleId]),
    );

    for (const contract of [
      'storage/v1',
      'secrets/v1',
      'settings/v1',
      'events/v1',
    ]) {
      assert.equal(provided.get(contract), 'core', contract);
    }

    assert.equal(provided.get('storage.backend/v1'), 'memory');
    assert.equal(provided.get('secrets.backend/v1'), 'memory');
  } finally {
    await host.close();
  }
});

void test('a second backend provider that is not chosen is quarantined', async () => {
  const host = await boot([await core(), memoryFoundation({ id: 'spare' })], {
    enabled: ['spare'],
  });

  try {
    assert.equal(host.platform.mode, 'normal');
    assert.equal(states(host.platform).spare, 'quarantined');
    assert.ok(
      reasonCodes(host.platform, 'spare')?.includes('unchosen_provider'),
    );
  } finally {
    await host.close();
  }
});

void test('without a chosen backend the host goes to recovery', async () => {
  const host = await boot([await core()], {
    foundation: { bundles: [memoryFoundation()], providers: {} },
  });

  try {
    assert.equal(host.platform.mode, 'recovery');
  } finally {
    await host.close();
  }
});

/** A replacement storage/v1, chosen in providers, that records what reaches it. */
const replacementStorage = (seen: string[]): EmbeddedBundle => {
  const documents = new Map<string, StoredDocument>();
  const keyOf = (type: string, id: string) => `${type} ${id}`;

  return {
    manifest: {
      manifestVersion: 1,
      id: 'altstore',
      version: '1.0.0',
      engines: { doric: '^1.0.0' },
      provides: ['storage/v1@1.0.0'],
      requires: [],
    },
    descriptor: {
      descriptorVersion: 1,
      bundle: { id: 'altstore', version: '1.0.0' },
      contracts: [
        {
          id: 'storage/v1',
          version: '1.0.0',
          kind: 'service',
          environment: 'host',
          cardinality: 'one',
          local: true,
          schema: 'schemas/storage/v1.json',
        },
      ],
    },
    host: {
      activate: ({ services }: HostContext) => {
        services.provide(
          defineService(StorageV1, {
            defineType: defineMethod({
              ...storageMethods.defineType,
              execute: (definition) => {
                seen.push(`define ${definition.type}`);

                return { dispose: () => undefined };
              },
            }),
            get: defineMethod({
              ...storageMethods.get,
              execute: async (key) => {
                await Promise.resolve();

                return documents.get(keyOf(key.type, key.id));
              },
            }),
            query: defineMethod({
              ...storageMethods.query,
              execute: async () => {
                await Promise.resolve();

                return { items: [] };
              },
            }),
            read: defineMethod({
              ...storageMethods.read,
              execute: async () => {
                await Promise.resolve();

                return { entries: [], lastSequence: 0, truncations: [] };
              },
            }),
            commit: defineMethod({
              ...storageMethods.commit,
              execute: async (batch) => {
                await Promise.resolve();

                for (const { type, id, value } of batch.put ?? []) {
                  const revision =
                    (documents.get(keyOf(type, id))?.revision ?? 0) + 1;

                  seen.push(`put ${type} ${id}`);
                  documents.set(keyOf(type, id), { type, id, revision, value });
                }

                return { position: seen.length };
              },
            }),
            health: defineMethod({
              ...storageMethods.health,
              execute: async () => {
                await Promise.resolve();

                return { status: 'ok' as const, writable: true };
              },
            }),
          }),
        );
      },
    },
  };
};

void test('a replacement storage/v1 chosen in providers is the one core settings use', async () => {
  const seen: string[] = [];
  const space = defineSettings({
    id: 'prefs.general/v1',
    schema: z.object({ theme: z.string() }).strict(),
  });
  let settings: Settings | undefined;
  const host = await boot(
    [
      await core(),
      replacementStorage(seen),
      probe('prefs', {
        requires: ['settings/v1@^1.0.0'],
        provides: [['prefs.general/v1', 'settings']],
        activate: ({ services }) => {
          settings = services.use(SettingsV1);
          settings.register(space);
        },
      }),
    ],
    { enabled: ['altstore'], providers: { 'storage/v1': 'altstore' } },
  );

  try {
    assert.equal(host.platform.mode, 'normal');
    assert.ok(settings);
    assert.equal((await settings.set(space, { theme: 'light' })).revision, 1);
    assert.deepEqual(await settings.get(space), { theme: 'light' });

    assert.deepEqual([...seen].sort(), [
      'define core.settings-generation/v1',
      'define core.settings/v1',
      'put core.settings-generation/v1 global',
      'put core.settings/v1 prefs.general/v1',
    ]);
  } finally {
    await host.close();
  }
});
