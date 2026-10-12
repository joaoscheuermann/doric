import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  defineSettings,
  type Services,
  type SettingsEntry,
  SettingsV1,
} from 'bundle/contracts';
import { z } from 'zod';

import {
  bootDesktop,
  builtDesktopPart,
  type Desktop,
  probe,
} from '../support/desktop.js';

const prefs = defineSettings({
  id: 'graph.prefs/v1',
  schema: z.object({ zoom: z.number().default(1) }).strict(),
});

const codeOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: unknown }).code;
  }

  return 'resolved';
};

const withCache = async (
  run: (directory: string) => Promise<void>,
): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), 'core-desktop-settings-'));

  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

/** The desktop with a `graph` bundle owning `graph.prefs/v1`, and its services. */
const bootWithOwner = async (
  directory: string,
  now?: () => number,
): Promise<{ desktop: Desktop; services: Services }> => {
  let captured: Services | undefined;
  const part = await builtDesktopPart();
  const desktop = await bootDesktop(
    [
      probe('graph', {
        requires: ['settings/v1@^1.0.0'],
        provides: [['graph.prefs/v1', 'settings']],
        activate: ({ services }) => {
          services.use(SettingsV1).register(prefs);
          captured = services;
        },
      }),
    ],
    {
      cacheDirectory: directory,
      ...(now === undefined ? {} : { core: part.createActivate({ now }) }),
    },
  );

  assert.ok(captured);

  return { desktop, services: captured };
};

void test('a space never written reads its defaults at revision 0, and no file appears before the first set', async () => {
  await withCache(async (directory) => {
    const { desktop, services } = await bootWithOwner(directory);

    try {
      const settings = services.use(SettingsV1);

      assert.deepEqual(await settings.get(prefs), { zoom: 1 });
      assert.deepEqual(await settings.entry(prefs), {
        value: { zoom: 1 },
        revision: 0,
        version: '1.0.0',
        updatedAt: new Date(0).toISOString(),
        generation: 0,
      });
      assert.deepEqual(await readdir(directory), []);
    } finally {
      await desktop.stop();
    }
  });
});

void test('set stores the value with its revision and write time, and notifies subscribers', async () => {
  await withCache(async (directory) => {
    const { desktop, services } = await bootWithOwner(directory, () =>
      Date.UTC(2026, 0, 2, 3, 4, 5, 6),
    );

    try {
      const settings = services.use(SettingsV1);
      const heard: SettingsEntry[] = [];

      settings.subscribe(prefs, (entry) => heard.push(entry));

      const first = await settings.set(prefs, { zoom: 2 });
      const second = await settings.set(
        prefs,
        { zoom: 3 },
        { expectedRevision: 1 },
      );

      assert.deepEqual(first, {
        value: { zoom: 2 },
        revision: 1,
        version: '1.0.0',
        updatedAt: '2026-01-02T03:04:05.006Z',
        generation: 1,
      });
      assert.equal(second.revision, 2);
      assert.deepEqual(await settings.get(prefs), { zoom: 3 });
      assert.deepEqual(
        heard.map(({ value, revision }) => ({ value, revision })),
        [
          { value: { zoom: 2 }, revision: 1 },
          { value: { zoom: 3 }, revision: 2 },
        ],
      );
      assert.deepEqual(await readdir(directory), ['settings.json']);
    } finally {
      await desktop.stop();
    }
  });
});

void test('a write at a stale revision is settings_conflict and changes nothing', async () => {
  await withCache(async (directory) => {
    const { desktop, services } = await bootWithOwner(directory);

    try {
      const settings = services.use(SettingsV1);

      await settings.set(prefs, { zoom: 2 });

      assert.equal(
        await codeOf(settings.set(prefs, { zoom: 9 }, { expectedRevision: 0 })),
        'settings_conflict',
      );
      const entry = await settings.entry(prefs);

      assert.deepEqual(
        { value: entry.value, revision: entry.revision },
        { value: { zoom: 2 }, revision: 1 },
      );
    } finally {
      await desktop.stop();
    }
  });
});

void test('a value outside the schema is invalid_input; an unregistered space is unknown_settings', async () => {
  await withCache(async (directory) => {
    const { desktop, services } = await bootWithOwner(directory);

    try {
      const settings = services.use(SettingsV1);
      const other = defineSettings({
        id: 'graph.other/v1',
        schema: z.object({}).strict(),
      });

      assert.equal(
        await codeOf(settings.set(prefs, { zoom: 'big' } as never)),
        'invalid_input',
      );
      assert.equal(await codeOf(settings.get(other)), 'unknown_settings');
      assert.deepEqual(await readdir(directory), []);
    } finally {
      await desktop.stop();
    }
  });
});

void test('the preferences survive a restart of the desktop over the same cache directory', async () => {
  await withCache(async (directory) => {
    const before = await bootWithOwner(directory);

    try {
      await before.services.use(SettingsV1).set(prefs, { zoom: 4 });
    } finally {
      await before.desktop.stop();
    }

    const after = await bootWithOwner(directory);

    try {
      const entry = await after.services.use(SettingsV1).entry(prefs);

      assert.deepEqual(
        { value: entry.value, revision: entry.revision },
        { value: { zoom: 4 }, revision: 1 },
      );
    } finally {
      await after.desktop.stop();
    }
  });
});

void test("a bundle cannot register settings in another bundle's namespace", async () => {
  const failures: unknown[] = [];
  const desktop = await bootDesktop([
    probe('intruder', {
      requires: ['settings/v1@^1.0.0'],
      activate: ({ services }) => {
        try {
          services.use(SettingsV1).register(prefs);
        } catch (error) {
          failures.push(error);
        }
      },
    }),
  ]);

  try {
    assert.equal((failures[0] as { code?: string }).code, 'not_owner');
  } finally {
    await desktop.stop();
  }
});
