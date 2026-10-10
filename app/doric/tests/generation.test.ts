// One desktopMain generation as main runs it, without Electron: the real
// runner and the core's built desktopMain part on the other end of an
// in-memory channel (the utility process boundary), and main's platform
// providers answering it. The fakes are what Electron would do with the
// requests: open windows and set the menu.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  type Activate,
  CommandsV1,
  type MenuSkeleton,
  type OpenWindowRequest,
} from 'bundle/contracts';
import {
  catalogSnapshot,
  createErrorClassRegistry,
  createPrincipal,
  createTransportPair,
  PLATFORM_VERSION,
  runGeneration,
  ServiceDirectory,
  statesOf,
} from 'bundle/runtime';

import { createSchemaValidators } from '../src/platform/bridge/validation';
import { resolveDistribution } from '../src/platform/catalog/resolve';
import { provideBroker } from '../src/platform/generation/broker';
import { GenerationProcess } from '../src/platform/generation/process';
import { silentLog } from '../src/platform/log';
import { CORE_DIST, coreDistribution } from './support/core';
import type { FixtureBundle } from './support/distribution';

interface Main {
  readonly opened: OpenWindowRequest[];
  readonly skeletons: { generation: number; skeleton: MenuSkeleton }[];
  readonly lastPaths: Map<string, string>;
  readonly process: GenerationProcess;
}

const corePart = async (): Promise<Activate | undefined> =>
  (
    (await import(pathToFileURL(`${CORE_DIST}/desktop/index.js`).href)) as {
      activate?: Activate;
    }
  ).activate;

const bootGeneration = async (
  options: {
    readonly bundles?: readonly FixtureBundle[];
    readonly parts?: Readonly<Record<string, Activate>>;
    readonly core?: string;
  } = {},
): Promise<Main> => {
  const { catalog } = await coreDistribution({
    ...(options.bundles === undefined ? {} : { bundles: options.bundles }),
    ...(options.core === undefined ? {} : { core: options.core }),
  });
  const resolution = resolveDistribution(catalog, 1);
  const kernel = new ServiceDirectory();
  const kernelPrincipal = createPrincipal(
    {
      directory: kernel,
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
  const opened: OpenWindowRequest[] = [];
  const skeletons: { generation: number; skeleton: MenuSkeleton }[] = [];
  const lastPaths = new Map<string, string>();

  provideBroker(kernelPrincipal, {
    windows: {
      open: async (request) => {
        opened.push(request);
      },
      focusOrOpen: async (key) => {
        opened.push({ key, path: `focus:${key}` });
      },
      lastPath: (key) => lastPaths.get(key) ?? null,
    },
    menus: {
      setSkeleton: (generation, skeleton) =>
        skeletons.push({ generation, skeleton }),
      add: () => undefined,
      addKeybinding: () => undefined,
      setContext: () => undefined,
    },
    cacheDirectory: async (bundleId) => `/cache/${bundleId}`,
    tokens: () => ({ '--background': 'x' }),
    notify: () => undefined,
    log: silentLog,
  });

  const process = new GenerationProcess({
    generation: 1,
    resolved: resolution.desktopMain,
    catalog: catalogSnapshot(
      resolution.desktopMain,
      statesOf({
        generation: 1,
        mode: 'normal',
        issues: [],
        bundles: [],
        errors: [],
        consumers: {},
      }),
    ),
    kernel,
    kernelPrincipal,
    validators: createSchemaValidators(),
    log: silentLog,
    spawn: () => {
      const pair = createTransportPair();

      void runGeneration({
        transport: pair.right,
        validators: createSchemaValidators(),
        errors: createErrorClassRegistry(),
        loadPart: async (entry) =>
          entry.id === 'core' ? await corePart() : options.parts?.[entry.id],
      });

      return { transport: pair.left, kill: () => pair.sever() };
    },
  });
  const activation = await process.start();

  assert.equal(activation.ok, true, activation.error);

  return { opened, skeletons, lastPaths, process };
};

describe('a desktopMain generation (core part, real runner)', () => {
  test('onAppReadyHook sets the default skeleton and opens the workspace at "/"', async () => {
    const main = await bootGeneration();

    try {
      await main.process.lifecycle('onAppReadyHook', {});

      assert.deepEqual(
        main.skeletons.map(({ generation, skeleton }) => ({
          generation,
          roles: skeleton.map((entry) => entry.role),
        })),
        [
          {
            generation: 1,
            roles: [
              'appMenu',
              'fileMenu',
              'editMenu',
              'viewMenu',
              'windowMenu',
              'help',
            ],
          },
        ],
      );
      assert.deepEqual(main.opened, [
        {
          key: 'workspace',
          path: '/',
          appearance: {
            size: { width: 1280, height: 800, minWidth: 960, minHeight: 640 },
            titleBar: 'integrated',
            background: 'window',
          },
        },
      ]);
    } finally {
      await main.process.stop();
    }
  });

  test('the workspace reopens at the last path main stored for it', async () => {
    const main = await bootGeneration();

    main.lastPaths.set('workspace', '/projects/p1/threads/t1');

    try {
      await main.process.lifecycle('onAppReadyHook', {});
      await main.process.lifecycle('onAppActivateHook', {});

      assert.deepEqual(
        main.opened.map(({ key, path }) => ({ key, path })),
        [
          { key: 'workspace', path: '/projects/p1/threads/t1' },
          { key: 'workspace', path: 'focus:workspace' },
        ],
      );
    } finally {
      await main.process.stop();
    }
  });

  test('core.open-settings/v1 opens the settings key at /settings with its size', async () => {
    const main = await bootGeneration();

    try {
      await main.process.services
        .use(CommandsV1)
        .execute('core.open-settings/v1', {}, main.process.call());

      assert.deepEqual(main.opened, [
        {
          key: 'settings',
          path: '/settings',
          appearance: {
            size: { width: 960, height: 720, minWidth: 720, minHeight: 520 },
            titleBar: 'integrated',
            background: 'window',
          },
        },
      ]);
    } finally {
      await main.process.stop();
    }
  });

  test('an unknown command answers unknown_command', async () => {
    const main = await bootGeneration();

    try {
      await assert.rejects(
        main.process.services
          .use(CommandsV1)
          .execute('probe.missing/v1', {}, main.process.call()),
        { code: 'unknown_command' },
      );
    } finally {
      await main.process.stop();
    }
  });

  test('no quit handler allows the quit', async () => {
    const main = await bootGeneration();

    try {
      assert.deepEqual(await main.process.lifecycle('onBeforeQuitHook', {}), {
        allow: true,
      });
    } finally {
      await main.process.stop();
    }
  });

  test('onActivateHook reports the bundles activated after the core, never the core', async () => {
    const seen: string[] = [];
    const main = await bootGeneration({
      bundles: [
        {
          id: 'probe',
          requires: ['hooks/v1@^1.0.0'],
          files: { 'desktop/index.js': '' },
        },
        {
          id: 'watcher',
          requires: ['hooks/v1@^1.0.0'],
          files: { 'desktop/index.js': '' },
        },
      ],
      parts: {
        watcher: ({ services }) => {
          void services;
        },
        probe: async ({ services }) => {
          const { HooksV1, AppHooksV1 } = await import('bundle/contracts');

          services
            .use(HooksV1)
            .use(AppHooksV1)
            .onActivateHook((input) => {
              seen.push(input.bundleId);
            });
        },
      },
    });

    try {
      // AppHooksV1 is defined once the core's hooks/v1 activated, so the
      // core itself is never reported; bundles activated later are.
      assert.ok(!seen.includes('core'));
      assert.ok(seen.includes('watcher'));
    } finally {
      await main.process.stop();
    }
  });
});
