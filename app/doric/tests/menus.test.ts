// `doric.menus/v1` in main and the platform providers' broker, with Electron's
// menu API as the boundary (a fake that records the templates it is given).
// The real expansion by Electron is covered by the Electron menu parity test.

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import { DoricNotificationsV1, type MenuSkeleton } from 'bundle/contracts';
import {
  createPrincipal,
  PLATFORM_VERSION,
  ServiceDirectory,
} from 'bundle/runtime';
import type { MenuItemConstructorOptions } from 'electron';

import { provideBroker } from '../src/platform/generation/broker';
import { silentLog } from '../src/platform/log';
import { NativeMenus } from '../src/platform/menus/native-menus';
import { showNotification } from '../src/platform/native/notifications';
import {
  type WindowEntry,
  WindowRegistry,
} from '../src/platform/windows/registry';

interface FakeMenu {
  readonly template: (MenuItemConstructorOptions & { submenu?: unknown })[];
  readonly items: { readonly submenu?: FakeMenu }[];
  append(item: unknown): void;
}

const fakeMenu = (template: MenuItemConstructorOptions[]): FakeMenu => {
  const entries = [...template];

  return {
    template: entries,
    items: template.map((entry) => ({
      ...(entry.role === undefined
        ? {}
        : { submenu: fakeMenu([{ label: `${entry.role} item` }]) }),
    })),
    append: (item) => entries.push(item as MenuItemConstructorOptions),
  };
};

const skeleton: MenuSkeleton = [
  { id: 'app', label: 'App', role: 'appMenu' },
  { id: 'file', label: 'File', role: 'fileMenu' },
  { id: 'edit', label: 'Edit', role: 'editMenu' },
  { id: 'view', label: 'View', role: 'viewMenu' },
  { id: 'window', label: 'Window', role: 'windowMenu' },
  { id: 'help', label: 'Help', role: 'help' },
];

const owner = { bundleId: 'probe', version: '1.0.0', generation: 1 };

let registry: WindowRegistry;
let applied: FakeMenu[];
let dispatched: { command: string; windowKey: string | null }[];
let menus: NativeMenus;
let workspace: WindowEntry;

const entry = (key: string, id: number): WindowEntry => ({
  key,
  window: { webContents: { id } } as unknown as WindowEntry['window'],
  appearance: { titleBar: 'integrated', background: 'window' },
  pinnedGeneration: 1,
  context: { path: null, focus: null },
});

beforeEach(() => {
  registry = new WindowRegistry();
  applied = [];
  dispatched = [];
  menus = new NativeMenus({
    registry,
    platform: 'linux',
    newestGeneration: () => 1,
    dispatch: (command, origin) => dispatched.push({ command, ...origin }),
    electron: {
      setApplicationMenu: (menu) => applied.push(menu as unknown as FakeMenu),
      buildFromTemplate: (template) => fakeMenu(template) as never,
      item: (options) => options as never,
    },
  });
  workspace = entry('workspace', 1);
  registry.add(workspace);
});

const top = () => applied.at(-1)?.template ?? [];
const viewMenu = () =>
  top().find((item) => item.role === 'viewMenu')?.submenu as
    | FakeMenu
    | undefined;

describe('native menus', () => {
  test('before any skeleton, Electron’s default menu stays', () => {
    menus.rebuild();

    assert.equal(applied.length, 0);
  });

  test('the core skeleton is Electron’s roles; the app menu exists only on macOS, Help only with items', () => {
    menus.setSkeleton(1, skeleton);

    assert.deepEqual(
      top().map((item) => item.role),
      ['fileMenu', 'editMenu', 'viewMenu', 'windowMenu'],
    );

    menus.add(1, {
      id: 'about',
      location: 'app/help',
      command: 'p.about/v1',
      label: 'About',
      owner,
    });

    assert.deepEqual(
      top().map((item) => item.role),
      ['fileMenu', 'editMenu', 'viewMenu', 'windowMenu', 'help'],
    );
  });

  test('an item goes after a separator in its menu, with its keybinding as label, and dispatches its command', () => {
    menus.setSkeleton(1, skeleton);
    menus.addKeybinding(1, {
      command: 'probe.ping/v1',
      key: 'CmdOrCtrl+Shift+P',
      owner,
    });
    menus.add(1, {
      id: 'ping',
      location: 'app/view',
      command: 'probe.ping/v1',
      label: 'Ping',
      owner,
    });
    registry.setFocused('workspace');
    menus.rebuild();

    const items = viewMenu()?.template ?? [];
    const ping = items.at(-1);

    assert.equal(items.at(-2)?.type, 'separator');
    assert.equal(ping?.label, 'Ping');
    assert.equal(ping?.accelerator, 'CmdOrCtrl+Shift+P');
    assert.equal(ping?.registerAccelerator, false);
    (ping as { click: () => void }).click();
    assert.deepEqual(dispatched, [
      { command: 'probe.ping/v1', windowKey: 'workspace' },
    ]);
  });

  test('a when condition follows the focused window’s context', () => {
    menus.setSkeleton(1, skeleton);
    menus.add(1, {
      id: 'thread',
      location: 'app/view',
      command: 'probe.thread/v1',
      label: 'Thread action',
      when: { path: '/projects/:projectId/threads/:threadId' },
      owner,
    });
    registry.setFocused('workspace');
    menus.rebuild();
    assert.ok(
      !(viewMenu()?.template ?? []).some(
        (item) => item.label === 'Thread action',
      ),
    );

    menus.setContext(
      'workspace',
      'path',
      '/projects/:projectId/threads/:threadId',
    );
    assert.ok(
      (viewMenu()?.template ?? []).some(
        (item) => item.label === 'Thread action',
      ),
    );
  });

  test('the same key with the same when is a registration conflict', () => {
    menus.addKeybinding(1, { command: 'a.one/v1', key: 'CmdOrCtrl+K', owner });

    assert.throws(
      () =>
        menus.addKeybinding(1, {
          command: 'b.two/v1',
          key: 'CmdOrCtrl+K',
          owner,
        }),
      { code: 'registration_conflict' },
    );
    menus.addKeybinding(1, {
      command: 'b.two/v1',
      key: 'CmdOrCtrl+K',
      when: { focus: 'composer' },
      owner,
    });
  });

  test('a context for a window that is not open is not_found', () => {
    assert.throws(() => menus.setContext('nope', 'path', '/'), {
      code: 'not_found',
    });
  });

  test('a window’s keybinding table holds its generation’s matching bindings', () => {
    menus.addKeybinding(1, { command: 'a.one/v1', key: 'CmdOrCtrl+K', owner });
    menus.addKeybinding(1, {
      command: 'a.two/v1',
      key: 'CmdOrCtrl+J',
      when: { focus: 'composer' },
      owner,
    });
    menus.addKeybinding(2, {
      command: 'a.three/v1',
      key: 'CmdOrCtrl+L',
      owner,
    });

    assert.deepEqual(menus.bindingsFor(workspace), [
      { key: 'CmdOrCtrl+K', command: 'a.one/v1' },
    ]);
  });

  test('what a bundle registered leaves with it', () => {
    menus.setSkeleton(1, skeleton);
    menus.add(1, {
      id: 'ping',
      location: 'app/view',
      command: 'p.ping/v1',
      label: 'Ping',
      owner,
    });
    menus.dropOwner(1, 'probe');

    assert.ok(!top().find((item) => item.role === 'viewMenu')?.submenu);
  });
});

describe('doric.notifications/v1 (broker)', () => {
  test('validates the request and shows it through the one notification function', async () => {
    const shown: { title: string; body: string }[] = [];
    const platform = createPrincipal(
      {
        directory: new ServiceDirectory(),
        catalog: {
          cardinality: () => undefined,
          activeProvider: () => undefined,
        },
        environment: 'desktopMain',
        generation: 0,
        generationSignal: new AbortController().signal,
        report: () => undefined,
      },
      {
        bundleId: 'doric',
        version: PLATFORM_VERSION,
        provides: 'any',
        requires: 'any',
      },
    );

    provideBroker(platform, {
      windows: {
        open: async () => undefined,
        focusOrOpen: async () => undefined,
        lastPath: () => null,
      },
      menus,
      cacheDirectory: async () => '/cache',
      tokens: () => ({}),
      notify: (request) =>
        showNotification(request, {
          api: {
            isSupported: () => true,
            create: (options) => ({
              on: () => undefined,
              show: () => shown.push(options),
            }),
          },
        }),
      log: silentLog,
    });

    const notifications = platform.services.use(DoricNotificationsV1);

    await notifications.show({
      title: '  Prompt finished  ',
      body: ' Thread A ',
    });
    await assert.rejects(
      async () => notifications.show({ title: 'x' } as never),
      { code: 'invalid_input' },
    );

    assert.deepEqual(shown, [{ title: 'Prompt finished', body: 'Thread A' }]);
  });
});
