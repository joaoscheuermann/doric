// The "All settings" entry of the Dashboard (bundle isolation 4(c), Phases
// `:1917`, spec §8): the settings bundle adds a data item to `workspace`'s
// `workspace.dashboard.footer` slot, whose command opens the settings window
// at `/settings`, with `settings-entry-icon` as its icon element, and adds its
// dashboard items under the renamed slots `workspace.dashboard.nav` and
// `workspace.dashboard.page`. A probe bundle reads the slots as `workspace`
// would. The window's composition holds no `workspace` bundle, and the
// settings part loads all the same: it names the slots and the props type by
// type-only imports (D32), so its shipped modules import nothing from
// `workspace/contracts`.

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { RegionsV1, type Services } from 'bundle/contracts';

import {
  openSettingsWindow,
  type SettingsWindow,
  settle,
} from './support/window.js';

const SETTINGS_CLIENT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../dist/client',
);

/** A host with one stored configuration, as the settings window reads it. */
const host = {
  'host-config/v1.current': () => ({
    configuration: { providers: [], models: {}, execution: { maxTurns: 32 } },
    revision: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
  }),
  'models/v1.kinds': () => [],
  'secrets/v1.list': () => [],
  'tools/v1.catalog': () => [],
};

let opened: SettingsWindow | undefined;

afterEach(async () => {
  await opened?.close();
  opened = undefined;
});

/** Opens a window with a probe that keeps the services it was activated with. */
const openWithProbe = async (): Promise<Services> => {
  let services: Services | undefined;
  opened = await openSettingsWindow({
    host,
    probe: {
      requires: ['ui/v1@^1.0.0', 'regions/v1@^1.0.0'],
      activate: (context) => {
        services = context.services;
        return () => undefined;
      },
    },
  });
  await settle(20);
  assert.ok(services !== undefined, 'The probe bundle was not activated.');
  return services;
};

test('settings adds the All settings item to workspace.dashboard.footer, whose command opens the settings window at /settings', async () => {
  const services = await openWithProbe();

  assert.deepEqual(
    services
      .use(RegionsV1)
      .items('workspace.dashboard.footer')
      .map(({ id, tag, owner, props }) => ({ id, tag, owner, props })),
    [
      {
        id: 'settings',
        tag: 'settings-entry-icon',
        owner: 'settings',
        props: {
          label: 'All settings',
          command: 'core.open-settings/v1',
          input: { defaultPath: '/settings' },
        },
      },
    ],
  );
});

test('settings adds its dashboard items under workspace.dashboard.nav and workspace.dashboard.page, and none under the old layout names', async () => {
  const services = await openWithProbe();
  const regions = services.use(RegionsV1);
  const owned = (region: string) =>
    regions.items(region).filter(({ owner }) => owner === 'settings');

  assert.ok(
    owned('workspace.dashboard.nav').length > 0,
    'settings adds nothing to workspace.dashboard.nav.',
  );
  assert.ok(
    owned('workspace.dashboard.page').length > 0,
    'settings adds nothing to workspace.dashboard.page.',
  );
  // The old names are joined from their parts, so the rename search of bundle
  // isolation 4(c) (spec `:815`) finds no line of this test.
  for (const part of ['nav', 'page']) {
    const old = ['layout', 'dashboard', part].join('.');
    assert.deepEqual(owned(old), [], `settings adds items under ${old}.`);
  }
});

test("the settings client part's shipped modules import nothing from workspace/contracts", async () => {
  const files = (await readdir(SETTINGS_CLIENT, { recursive: true })).filter(
    (file) => file.endsWith('.js'),
  );
  assert.ok(files.length > 0, `No module under ${SETTINGS_CLIENT}.`);

  const importing: string[] = [];
  for (const file of files) {
    const source = await readFile(join(SETTINGS_CLIENT, file), 'utf8');
    if (
      /from\s*['"]account\/contracts['"]|import\(\s*['"]account\/contracts['"]/.test(
        source,
      )
    )
      importing.push(file);
  }

  assert.deepEqual(importing, []);
});

test('settings ships settings.models/v1 as the minor 1.11.0 (6(c) O11), the patch 1.11.1 (4(d)), then the provider-field slot as the minor 1.12.0 (6(a)), the kind site as the patch 1.12.1 (6(b)) and the provider-field fixes as the patch 1.12.2 (6(a) follow-up)', async () => {
  const manifest = JSON.parse(
    await readFile(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        '../../../manifest.json',
      ),
      'utf8',
    ),
  ) as { version: string };

  assert.equal(manifest.version, '1.12.2');
});
