// Other bundles, client parts included, open windows and contribute menus
// through `windows/v1` and `menus/v1` (stage 8 parity evidence), a failing
// client part is quarantined without blocking the window, and a new host
// generation loads beside the old one, which stops once no window pins it.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { type BrowserWindow, Menu, type MenuItem } from 'electron';

import { coreDistribution } from '../tests/support/core';
import type { FixtureBundle } from '../tests/support/distribution';
import {
  type Booted,
  bootPlatform,
  type FakeHost,
  page,
  startFakeHost,
  until,
} from './support/harness';

const probeDesktop = `
import { AppHooksV1, CommandsV1, HooksV1, WindowsV1, defineCommand } from 'bundle/contracts';
import { z } from 'zod';

export const activate = ({ services }) => {
  services.use(CommandsV1).register(defineCommand({
    id: 'probe.ping/v1',
    input: z.object({}).strict(),
    execute: async (_input, call) => {
      await services.use(WindowsV1).open({ key: 'pinged', path: '/pinged' }, call);
    },
  }));
  services.use(HooksV1).use(AppHooksV1).onAppReadyHook(async (_input, call) => {
    await services.use(WindowsV1).open({ key: 'graph', path: '/graph' }, call);
  });
};
`;

const probeClient = `
import { MenusV1, WindowsV1 } from 'bundle/contracts';

export const activate = async ({ services }) => {
  if (location.pathname !== '/') return;
  const menus = services.use(MenusV1);
  await menus.addItem({ id: 'ping', location: 'app/view', command: 'probe.ping/v1', label: 'Ping' });
  await menus.addKeybinding({ command: 'probe.ping/v1', key: 'CmdOrCtrl+Shift+9' });
  try {
    await menus.addKeybinding({ command: 'probe.other/v1', key: 'CmdOrCtrl+Shift+9' });
  } catch (error) {
    document.body.dataset.conflict = error.code;
  }
  await services.use(WindowsV1).open({ key: 'x', path: '/x' });
};
`;

// Records, in the opened window's path, who asked and from which window.
const observerDesktop = `
import { HooksV1 } from 'bundle/contracts';
import { CoreHooksV1 } from 'core/contracts';

export const activate = ({ services }) => {
  services.use(HooksV1).use(CoreHooksV1).onBeforeOpenWindowHook((request, call) =>
    request.key === 'x'
      ? { ...request, path: '/x/' + (call.scope?.windowKey ?? 'none') }
      : request);
};
`;

// Tells, by the windows it opens, which app hooks its generation received.
const watcherDesktop = `
import { AppHooksV1, HooksV1, WindowsV1 } from 'bundle/contracts';

export const activate = ({ services }) => {
  const app = services.use(HooksV1).use(AppHooksV1);
  app.onGenerationReadyHook(async ({ generation }, call) => {
    await services.use(WindowsV1).open({ key: 'generation', path: '/generation/' + generation }, call);
  });
  app.onAppReadyHook(async (_input, call) => {
    await services.use(WindowsV1).open({ key: 'app-ready', path: '/app-ready' }, call);
  });
};
`;

const brokenClient = `
export const activate = () => { throw new Error('broken on purpose'); };
`;

const fixtures: readonly FixtureBundle[] = [
  {
    id: 'probe',
    requires: [
      'windows/v1@^1.0.0',
      'menus/v1@^1.0.0',
      'commands/v1@^1.0.0',
      'hooks/v1@^1.0.0',
    ],
    provides: [
      { id: 'probe.ping/v1', environment: 'desktopMain', kind: 'command' },
    ],
    files: { 'desktop/index.js': probeDesktop, 'client/index.js': probeClient },
  },
  {
    id: 'observer',
    requires: ['hooks/v1@^1.0.0', 'core.hooks/v1@^1.0.0'],
    files: { 'desktop/index.js': observerDesktop },
  },
  { id: 'broken', files: { 'client/index.js': brokenClient } },
];

let host: FakeHost;
let booted: Booted;
let workspace: BrowserWindow;

const find = (
  items: readonly MenuItem[],
  label: string,
): MenuItem | undefined => {
  for (const item of items) {
    if (item.label === label) {
      return item;
    }

    const nested =
      item.submenu === undefined || item.submenu === null
        ? undefined
        : find(item.submenu.items, label);

    if (nested !== undefined) {
      return nested;
    }
  }

  return undefined;
};

describe('desktop platform with fixture bundles', () => {
  before(async () => {
    host = await startFakeHost(await coreDistribution({ bundles: fixtures }));
    booted = await bootPlatform({ host });
    workspace = await booted.window('workspace');
  });

  after(async () => {
    await booted.dispose();
    await host.close();
  });

  describe('bundles through windows/v1 and menus/v1', () => {
    test('a desktopMain part opens its window under its own key', async () => {
      const graph = await booted.window('probe:graph');

      assert.equal(new URL(graph.webContents.getURL()).pathname, '/graph');
    });

    test('a client part opens a window through windows/v1 with the calling window’s key', async () => {
      const x = await booted.window('probe:x');

      assert.equal(new URL(x.webContents.getURL()).pathname, '/x/workspace');
    });

    test('a client item appears in the View menu and runs its desktopMain command', async () => {
      const item = await until(
        () => find(Menu.getApplicationMenu()?.items ?? [], 'Ping'),
        'the Ping menu item',
      );

      assert.equal(item.accelerator, 'CmdOrCtrl+Shift+9');
      workspace.focus();
      item.click();

      const pinged = await booted.window('probe:pinged');

      assert.equal(new URL(pinged.webContents.getURL()).pathname, '/pinged');
    });

    test('a second binding of the same key is refused with registration_conflict', async () => {
      assert.equal(
        await page(workspace.webContents, 'document.body.dataset.conflict'),
        'registration_conflict',
      );
    });

    test('a client part that throws is quarantined and the window still becomes ready', async () => {
      const diagnostics = booted.logs.filter(
        (record) => record.message === 'Window diagnostic',
      );

      assert.ok(
        diagnostics.some((record) => {
          const diagnostic = record.fields.diagnostic as
            | { kind?: string; bundleId?: string; reason?: { code?: string } }
            | undefined;

          return (
            diagnostic?.kind === 'quarantine' &&
            diagnostic.bundleId === 'broken' &&
            diagnostic.reason?.code === 'activate_failed'
          );
        }),
      );
      assert.equal(
        await page(workspace.webContents, 'document.body.dataset.ready'),
        'yes',
      );
    });
  });

  describe('a new host generation', () => {
    test('loads beside the old one; windows keep theirs until they reload, then the old process stops', async () => {
      const first = booted.platform.newestGeneration as number;
      const next = await coreDistribution({
        generation: 2,
        bundles: [
          {
            id: 'watcher',
            requires: ['windows/v1@^1.0.0', 'hooks/v1@^1.0.0'],
            files: { 'desktop/index.js': watcherDesktop },
          },
        ],
      });

      host.publish(next.catalog, next.artifacts);

      const second = await until(() => {
        const newest = booted.platform.newestGeneration;

        return newest !== undefined && newest !== first ? newest : undefined;
      }, 'the next generation');

      const announced = await booted.window('watcher:generation');

      assert.equal(
        new URL(announced.webContents.getURL()).pathname,
        `/generation/${second}`,
      );
      assert.equal(
        booted.platform.registry.byKey('watcher:app-ready'),
        undefined,
      );
      assert.equal(
        await page(
          workspace.webContents,
          `document.querySelector('meta[name="doric-generation"]').getAttribute('content')`,
        ),
        String(first),
      );
      assert.ok(booted.platform.generationOf(first) !== undefined);

      for (const entry of booted.platform.registry.all()) {
        if (entry.key !== 'workspace') {
          entry.window.destroy();
        }
      }

      workspace.webContents.reload();
      await until(
        async () =>
          (await page<string | null>(
            workspace.webContents,
            `document.querySelector('meta[name="doric-generation"]')?.getAttribute('content') ?? null`,
          )) === String(second) || undefined,
        'the reloaded workspace on the new generation',
      );
      await until(
        () => booted.platform.generationOf(first) === undefined || undefined,
        'the old generation to stop',
      );
      // The new generation has no probe: its item left the menu.
      await until(
        () =>
          find(Menu.getApplicationMenu()?.items ?? [], 'Ping') === undefined ||
          undefined,
        'the Ping item to leave',
      );
    });
  });
});
