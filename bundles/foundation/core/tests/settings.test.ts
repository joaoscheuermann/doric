import assert from 'node:assert/strict';
import test from 'node:test';

import {
  defineSettings,
  type Secrets,
  SecretsV1,
  type Settings,
  type SettingsEntry,
  SettingsV1,
} from 'bundle/contracts';
import { createMemoryStore } from 'storage/memory';
import { z } from 'zod';

import { boot, core, errorKinds, probe } from './support/host.js';

// D-SE: the settings/v1 facade (stage 2+3 design §5.3).

const general = defineSettings({
  id: 'prefs.general/v1',
  schema: z
    .object({ theme: z.string().default('dark'), size: z.number().optional() })
    .strict(),
});

const other = defineSettings({
  id: 'prefs.other/v1',
  schema: z.object({ on: z.boolean().default(false) }).strict(),
});

const named = defineSettings({
  id: 'prefs.named/v1',
  schema: z.object({ name: z.string() }).strict(),
});

const at = Date.UTC(2026, 9, 9, 12, 0, 0, 5);

/** A bundle that owns the `prefs.*` spaces and hands its stubs to the test. */
const prefs = (
  options: {
    readonly register?: boolean;
    readonly onActivate?: (settings: Settings, secrets: Secrets) => void;
  } = {},
) => {
  let settings: Settings | undefined;
  let secrets: Secrets | undefined;

  return {
    bundle: probe('prefs', {
      requires: ['settings/v1@^1.0.0', 'secrets/v1@^1.0.0'],
      provides: [
        ['prefs.general/v1', 'settings', '1.2.0'],
        ['prefs.other/v1', 'settings'],
        ['prefs.named/v1', 'settings'],
      ],
      activate: ({ services }) => {
        settings = services.use(SettingsV1);
        secrets = services.use(SecretsV1);

        if (options.register !== false) {
          settings.register(general);
          settings.register(other);
          settings.register(named);
        }

        options.onActivate?.(settings, secrets);
      },
    }),
    get settings(): Settings {
      assert.ok(settings);

      return settings;
    },
    get secrets(): Secrets {
      assert.ok(secrets);

      return secrets;
    },
  };
};

void test('a space never written answers its defaults at revision 0', async () => {
  const owner = prefs();
  const host = await boot([await core(), owner.bundle]);

  try {
    assert.deepEqual(await owner.settings.entry(general), {
      value: { theme: 'dark' },
      revision: 0,
      version: '1.2.0',
      updatedAt: new Date(0).toISOString(),
      generation: 0,
    });
    assert.deepEqual(await owner.settings.get(other), { on: false });
    await assert.rejects(owner.settings.entry(named), {
      code: 'settings_missing',
    });
  } finally {
    await host.close();
  }
});

void test('each write adds one to the space revision and to the global generation', async () => {
  const owner = prefs();
  const host = await boot([await core({ now: () => at }), owner.bundle]);

  try {
    const first = await owner.settings.set(general, { theme: 'light' });

    assert.deepEqual(first, {
      value: { theme: 'light' },
      revision: 1,
      version: '1.2.0',
      updatedAt: '2026-10-09T12:00:00.005Z',
      generation: 1,
    });

    const second = await owner.settings.set(general, { size: 3 });

    assert.equal(second.revision, 2);
    assert.equal(second.generation, 2);
    assert.deepEqual(second.value, { theme: 'dark', size: 3 });

    const elsewhere = await owner.settings.set(other, { on: true });

    assert.equal(elsewhere.revision, 1);
    assert.equal(elsewhere.generation, 3);

    assert.deepEqual(await owner.settings.entry(general), second);
    assert.deepEqual(await owner.settings.get(other), { on: true });
  } finally {
    await host.close();
  }
});

void test('a written space survives a restart over the same storage', async () => {
  const store = createMemoryStore();
  const first = prefs();
  const before = await boot([await core({ now: () => at }), first.bundle], {
    memory: { store },
  });
  let written: SettingsEntry;

  try {
    await first.settings.set(general, { theme: 'light' });
    written = await first.settings.set(general, { theme: 'solar', size: 2 });
  } finally {
    await before.close();
  }

  const second = prefs();
  const after = await boot([await core(), second.bundle], {
    memory: { store },
  });

  try {
    assert.deepEqual(await second.settings.entry(general), written);

    const next = await second.settings.set(other, { on: true });

    assert.equal(next.generation, 3);
  } finally {
    await after.close();
  }
});

void test('an expected revision that does not match refuses the write', async () => {
  const owner = prefs();
  const host = await boot([await core(), owner.bundle]);

  try {
    await owner.settings.set(general, { theme: 'light' });

    await assert.rejects(
      owner.settings.set(general, { theme: 'x' }, { expectedRevision: 0 }),
      { code: 'settings_conflict' },
    );

    const matched = await owner.settings.set(
      general,
      { theme: 'x' },
      { expectedRevision: 1 },
    );

    assert.equal(matched.revision, 2);
    assert.deepEqual(await owner.settings.get(general), { theme: 'x' });
  } finally {
    await host.close();
  }
});

void test('a value the schema refuses is invalid_input and changes nothing', async () => {
  const owner = prefs();
  const host = await boot([await core(), owner.bundle]);

  try {
    await owner.settings.set(general, { theme: 'light' });

    await assert.rejects(owner.settings.set(general, { theme: 7 } as never), {
      code: 'invalid_input',
    });
    await assert.rejects(
      owner.settings.set(general, { color: 'red' } as never),
      {
        code: 'invalid_input',
      },
    );

    const entry = await owner.settings.entry(general);

    assert.equal(entry.revision, 1);
    assert.deepEqual(entry.value, { theme: 'light' });
  } finally {
    await host.close();
  }
});

void test('spaces are registered by the bundle their namespace names, once, from provides', async () => {
  const owner = prefs({ register: false });
  const host = await boot([await core(), owner.bundle]);

  try {
    await assert.rejects(owner.settings.entry(general), {
      code: 'unknown_settings',
    });
    await assert.rejects(owner.settings.set(general, {}), {
      code: 'unknown_settings',
    });
    assert.throws(
      () =>
        owner.settings.register(
          defineSettings({ id: 'git.prefs/v1', schema: z.object({}) }),
        ),
      { code: 'not_owner' },
    );
    assert.throws(
      () =>
        owner.settings.register(
          defineSettings({ id: 'prefs.undeclared/v1', schema: z.object({}) }),
        ),
      { code: 'undeclared_provide' },
    );

    const registration = owner.settings.register(general);

    assert.throws(() => owner.settings.register(general), {
      code: 'registration_conflict',
    });

    registration.dispose();
    await assert.rejects(owner.settings.entry(general), {
      code: 'unknown_settings',
    });
  } finally {
    await host.close();
  }
});

void test('subscribers see each write; a failing one does not fail the write', async () => {
  const seen: unknown[] = [];
  const owner = prefs({
    onActivate: (settings) => {
      settings.subscribe(general, () => {
        throw new Error('listener broke');
      });
      settings.subscribe(general, (entry) => {
        seen.push([entry.revision, entry.value]);
      });
    },
  });
  const host = await boot([await core(), owner.bundle]);

  try {
    await owner.settings.set(general, { theme: 'light' });
    await owner.settings.set(other, { on: true });

    assert.deepEqual(seen, [[1, { theme: 'light' }]]);
    assert.ok(
      errorKinds(host.platform).includes('prefs:settings_listener_failed'),
    );
  } finally {
    await host.close();
  }
});

void test('subscribers run before the write queue moves on: a delete queued behind sees the new references', async () => {
  const references = defineSettings({
    id: 'prefs.general/v1',
    schema: z.object({ credentialId: z.string().optional() }).strict(),
  });
  let latest: string | undefined;
  const owner = prefs({
    register: false,
    onActivate: (settings, secrets) => {
      settings.register(references);
      settings.subscribe(references, (entry) => {
        latest = entry.value.credentialId;
      });
      secrets.registerReferences(() => (latest === undefined ? [] : [latest]));
    },
  });
  const host = await boot([await core(), owner.bundle]);

  try {
    const credential = await owner.secrets.create({
      kind: 'API_TOKEN',
      name: 'openrouter',
      secret: 'sk-1',
    });

    // Both writes start together; the delete runs after the set settled.
    const [, removal] = await Promise.all([
      owner.settings.set(references, { credentialId: credential.id }),
      owner.secrets.delete({ id: credential.id }),
    ]);

    assert.equal(removal, 'referenced');
    assert.equal(
      (await owner.secrets.resolve({ id: credential.id })).secret,
      'sk-1',
    );

    await owner.settings.set(references, {});
    assert.equal(await owner.secrets.delete({ id: credential.id }), 'deleted');
  } finally {
    await host.close();
  }
});
