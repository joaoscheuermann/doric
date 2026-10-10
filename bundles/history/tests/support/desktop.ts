import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type {
  Activate,
  DesktopContext,
  Services,
  StorageIdentity,
} from 'bundle/contracts';
import {
  activateEnvironment,
  type CatalogCandidate,
  catalogSnapshot,
  catalogView,
  createHopCall,
  createPrincipal,
  type Descriptor,
  DiagnosticsStore,
  type ManifestV1,
  PLATFORM_VERSION,
  providePlatformServices,
  resolveEnvironment,
  ServiceDirectory,
  type ServiceRuntime,
} from 'bundle/runtime';
import { createMinimalHooks } from 'bundle/testing';
import { z } from 'zod';

const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, 'utf8')) as unknown;

interface DesktopBundle {
  readonly manifest: ManifestV1;
  readonly descriptor: Descriptor;
  readonly activate?: Activate<DesktopContext>;
}

/** The test core: the platform's minimal hooks/v1 provider, nothing else. */
const core: DesktopBundle = {
  manifest: {
    manifestVersion: 1,
    id: 'core',
    version: '1.0.0',
    engines: { doric: '^1.0.0' },
    provides: ['hooks/v1@1.0.0'],
    requires: [],
  },
  descriptor: {
    descriptorVersion: 1,
    bundle: { id: 'core', version: '1.0.0' },
    contracts: [
      {
        id: 'hooks/v1',
        version: '1.0.0',
        kind: 'service',
        environment: 'desktopMain',
        cardinality: 'one',
        local: true,
        schema: 'schemas/hooks/v1.json',
      },
    ],
  },
  activate: ({ services }) => {
    services.provide(createMinimalHooks());
  },
};

export interface Desktop {
  /** The platform principal's services, as another bundle would use them. */
  readonly services: Services;
  /** Bundle states after activation. */
  readonly states: Readonly<Record<string, string>>;
  /** Fires `doric.app.hooks/v1.onBeforeQuitHook` as main does on quit. */
  beforeQuit(): Promise<unknown>;
  /** Deactivates every bundle, as a generation stop does. */
  stop(): Promise<void>;
}

/**
 * One desktopMain environment in this process: the history bundle from its
 * build, a test core providing hooks/v1, the platform's local providers with
 * the given storage identity in `doric.catalog/v1.get()`, and a fake of
 * main's `doric.cache/v1` answering `cacheDirectory`.
 */
export const bootDesktop = async (options: {
  readonly cacheDirectory: string;
  readonly storage?: StorageIdentity;
}): Promise<Desktop> => {
  const history: DesktopBundle = {
    manifest: (await readJson(
      'bundles/history/dist/manifest.json',
    )) as ManifestV1,
    descriptor: (await readJson(
      'bundles/history/dist/contracts.json',
    )) as Descriptor,
    activate: (
      (await import(
        pathToFileURL(resolve('bundles/history/dist/desktop/index.js')).href
      )) as { activate: Activate<DesktopContext> }
    ).activate,
  };
  const all = [core, history];
  const candidates: CatalogCandidate[] = all.map((bundle) => ({
    id: bundle.manifest.id,
    source: { kind: 'embedded' },
    manifest: bundle.manifest,
    descriptor: bundle.descriptor,
    errors: [],
  }));
  const resolved = resolveEnvironment(
    {
      candidates,
      composition: {
        core: 'core',
        enabled: all.map(({ manifest }) => manifest.id),
        providers: {},
      },
      platformVersion: PLATFORM_VERSION,
      generation: 1,
    },
    'desktopMain',
  );
  const controller = new AbortController();
  const diagnostics = new DiagnosticsStore({ generation: 1 });

  diagnostics.load(resolved);

  const directory = new ServiceDirectory();
  const runtime: ServiceRuntime = {
    directory,
    catalog: catalogView(resolved),
    environment: 'desktopMain',
    generation: 1,
    generationSignal: controller.signal,
    report: (entry) => diagnostics.report(entry),
  };
  const platform = createPrincipal(runtime, {
    bundleId: 'doric',
    version: PLATFORM_VERSION,
    provides: 'any',
    requires: 'any',
  });

  providePlatformServices(platform, {
    snapshot: () => catalogSnapshot(resolved, diagnostics, options.storage),
    diagnostics,
    sink: { write: () => undefined },
  });
  directory.register({
    contractId: 'doric.cache/v1',
    bundleId: 'doric',
    version: PLATFORM_VERSION,
    contractVersion: '1.0.0',
    environment: 'desktopMain',
    cardinality: 'one',
    methods: { directory: { input: z.tuple([]), output: z.string() } },
    origin: 'remote',
    invoke: async () => options.cacheDirectory,
  });

  const byId = new Map(all.map((bundle) => [bundle.manifest.id, bundle]));
  const activation = await activateEnvironment({
    resolved,
    runtime,
    platform,
    diagnostics,
    loadPart: async (entry) =>
      byId.get(entry.id)?.activate as Activate | undefined,
  });

  return {
    services: platform.services,
    states: Object.fromEntries(
      diagnostics.snapshot().bundles.map(({ id, state }) => [id, state]),
    ),
    beforeQuit: async () => {
      const hooks = activation.appHooks();

      if (hooks === undefined) {
        throw new Error('doric.app.hooks/v1 was never defined.');
      }

      return hooks.onBeforeQuitHook.execute(
        {},
        createHopCall({
          caller: platform.caller,
          generationSignal: controller.signal,
        }),
      );
    },
    stop: async () => {
      await activation.stop();
      controller.abort();
    },
  };
};
