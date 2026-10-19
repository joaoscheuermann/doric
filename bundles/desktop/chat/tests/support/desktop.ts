// One desktopMain environment in this process for the composer's service
// tests: the chat bundle's built desktop part, a test core providing
// `hooks/v1`, and a test shell standing for the bundles that provide the rest
// of what the chat manifest declares in `requires` (`ui/v1`, `navigation/v1`,
// `regions/v1`, `commands/v1`, `runtime.threads/v1` and `comments/v1`). The
// parts of that shell are never called — the composer service reaches nothing
// but its own state and the flushes registered with it.

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { Activate, DesktopContext } from 'bundle/contracts';
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

/** The test core: the platform's minimal `hooks/v1` provider, nothing else. */
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

/**
 * The test shell: the providers of everything the chat manifest declares in
 * `requires` that the core does not give it. None of them is called.
 */
const shell: DesktopBundle = {
  manifest: {
    manifestVersion: 1,
    id: 'shell',
    version: '1.0.0',
    engines: { doric: '^1.0.0' },
    provides: [
      'ui/v1@1.0.0',
      'navigation/v1@1.0.0',
      'regions/v1@1.0.0',
      'commands/v1@1.0.0',
      'runtime.threads/v1@1.3.0',
      'runtime.attachments/v1@1.0.0',
      'comments/v1@1.0.0',
    ],
    requires: [],
  },
  descriptor: {
    descriptorVersion: 1,
    bundle: { id: 'shell', version: '1.0.0' },
    contracts: [
      'ui/v1',
      'navigation/v1',
      'regions/v1',
      'commands/v1',
      'comments/v1',
    ]
      .map((id) => ({
        id,
        version: '1.0.0',
        kind: 'service' as const,
        environment: 'desktopMain' as const,
        cardinality: 'one' as const,
        local: true,
        schema: `schemas/${id}.json`,
      }))
      .concat([
        {
          id: 'runtime.threads/v1',
          version: '1.3.0',
          kind: 'service' as const,
          environment: 'desktopMain' as const,
          cardinality: 'one' as const,
          local: true,
          schema: 'schemas/runtime.threads/v1.json',
        },
        {
          id: 'runtime.attachments/v1',
          version: '1.0.0',
          kind: 'service' as const,
          environment: 'desktopMain' as const,
          cardinality: 'one' as const,
          local: true,
          schema: 'schemas/runtime.attachments/v1.json',
        },
      ]),
  },
};

/** The platform principal's services, as another bundle would use them. */
export interface Desktop {
  readonly services: import('bundle/contracts').Services;
  /** Bundle states after activation. */
  readonly states: Readonly<Record<string, string>>;
  /** Deactivates every bundle, as a generation stop does. */
  stop(): Promise<void>;
}

/**
 * One desktopMain environment in this process: the chat bundle from its build,
 * the test core and the test shell.
 */
export const bootDesktop = async (): Promise<Desktop> => {
  const chat: DesktopBundle = {
    manifest: (await readJson(
      'bundles/desktop/chat/dist/manifest.json',
    )) as ManifestV1,
    descriptor: (await readJson(
      'bundles/desktop/chat/dist/contracts.json',
    )) as Descriptor,
    activate: (
      (await import(
        pathToFileURL(resolve('bundles/desktop/chat/dist/desktop/index.js'))
          .href
      )) as { activate: Activate<DesktopContext> }
    ).activate,
  };

  const all = [core, shell, chat];
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
