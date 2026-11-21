// The "Settings" entry of the account menu (bundle isolation 4(b), spec §7–§8,
// decision O10): the settings bundle adds a data item to the account's
// `account.menu` slot, whose command opens the settings window at
// `/settings`, and defines its icon element, `settings-entry-icon`. A probe
// bundle reads the slot as the account would. The window's composition holds
// no `account` bundle, and the settings part loads all the same: it names
// `account.menu` by a type-only import (D32), so its shipped modules import
// nothing from `account/contracts`.

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { RegionsV1, type Services, UiV1 } from 'bundle/contracts';

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

test('settings adds the Settings item to account.menu, whose command opens the settings window at /settings', async () => {
  const services = await openWithProbe();

  assert.deepEqual(
    services
      .use(RegionsV1)
      .items('account.menu')
      .map(({ id, tag, owner, props }) => ({ id, tag, owner, props })),
    [
      {
        id: 'settings',
        tag: 'settings-entry-icon',
        owner: 'settings',
        props: {
          label: 'Settings',
          command: 'core.open-settings/v1',
          input: { defaultPath: '/settings' },
        },
      },
    ],
  );
});

test("the Settings item's icon element, settings-entry-icon, draws one glyph", async () => {
  const services = await openWithProbe();
  const ui = services.use(UiV1);

  const icon = ui.create('settings-entry-icon') as HTMLElement;
  opened?.document.body.append(icon);
  await settle(20);

  assert.equal(
    icon.querySelectorAll('svg').length,
    1,
    `settings-entry-icon draws: ${icon.innerHTML}`,
  );
  ui.dispose(icon);
});

test("the settings client part's shipped modules import nothing from account/contracts", async () => {
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
