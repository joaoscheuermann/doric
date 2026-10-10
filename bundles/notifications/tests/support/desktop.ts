import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { Activate, DesktopContext, Services } from 'bundle/contracts';
import {
  activateEnvironment,
  type CatalogCandidate,
  catalogSnapshot,
  catalogView,
  createPrincipal,
  type Descriptor,
  DiagnosticsStore,
  type ManifestV1,
  PLATFORM_VERSION,
  platformContracts,
  providePlatformServices,
  resolveEnvironment,
  ServiceDirectory,
  type ServiceRuntime,
} from 'bundle/runtime';
import { createMinimalHooks } from 'bundle/testing';

const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, 'utf8')) as unknown;

interface DesktopBundle {
  readonly manifest: ManifestV1;
  readonly descriptor: Descriptor;
  readonly activate?: Activate<DesktopContext>;
}

/**
 * The test core: the platform's minimal hooks/v1 provider in desktopMain,
 * and the client-only `navigation/v1` it publishes for windows (never
 * activated here), as the real core does.
 */
const core: DesktopBundle = {
  manifest: {
    manifestVersion: 1,
    id: 'core',
    version: '1.0.0',
    engines: { doric: '^1.0.0' },
    provides: ['hooks/v1@1.0.0', 'navigation/v1@1.0.0'],
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
      {
        id: 'navigation/v1',
        version: '1.0.0',
        kind: 'service',
        environment: 'client',
        cardinality: 'one',
        local: true,
        schema: 'schemas/navigation/v1.json',
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
  /** Deactivates every bundle, as a generation stop does. */
  stop(): Promise<void>;
}

/**
 * One desktopMain environment in this process: the notifications bundle from
 * its build, a test core providing hooks/v1, the platform's local providers,
 * and a fake of main's `doric.notifications/v1` answering with `show`.
 */
export const bootDesktop = async (options: {
  readonly show: (request: unknown) => Promise<void>;
}): Promise<Desktop> => {
  const notifications: DesktopBundle = {
    manifest: (await readJson(
      'bundles/notifications/dist/manifest.json',
    )) as ManifestV1,
    descriptor: (await readJson(
      'bundles/notifications/dist/contracts.json',
    )) as Descriptor,
    activate: (
      (await import(
        pathToFileURL(resolve('bundles/notifications/dist/desktop/index.js'))
          .href
      )) as { activate: Activate<DesktopContext> }
    ).activate,
  };
  const all = [core, notifications];
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
    snapshot: () => catalogSnapshot(resolved, diagnostics),
    diagnostics,
    sink: { write: () => undefined },
  });
  directory.register({
    contractId: 'doric.notifications/v1',
    bundleId: 'doric',
    version: PLATFORM_VERSION,
    contractVersion: '1.0.0',
    environment: 'desktopMain',
    cardinality: 'one',
    methods: platformContracts['doric.notifications/v1'].methods,
    origin: 'remote',
    invoke: (_method, input) => options.show(input),
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
    stop: async () => {
      await activation.stop();
      controller.abort();
    },
  };
};
