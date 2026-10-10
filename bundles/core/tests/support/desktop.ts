import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  type Activate,
  type Call,
  type DesktopContext,
  type LogRecord,
  openWindowRequestSchema,
  type Services,
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
  type ProviderRecord,
  providePlatformServices,
  resolveEnvironment,
  ServiceDirectory,
  type ServiceRuntime,
} from 'bundle/runtime';
import { z } from 'zod';

import type * as DesktopPart from '../../src/desktop/index.js';

const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, 'utf8')) as unknown;

/** The core's desktopMain part exactly as its build ships it. */
export const builtDesktopPart = async (): Promise<typeof DesktopPart> =>
  (await import(
    pathToFileURL(resolve('bundles/core/dist/desktop/index.js')).href
  )) as typeof DesktopPart;

/** One call main's broker received: `<contract>.<method>`, its input and call. */
export interface BrokerCall {
  readonly method: string;
  readonly input: unknown;
  readonly call: Call;
}

/** How the fake main answers; every call is recorded in `calls` first. */
export interface BrokerOptions {
  /** `doric.windows/v1.lastPath` by key; null when absent. */
  readonly lastPaths?: Readonly<Record<string, string>>;
  /** `doric.cache/v1.directory` of the core. */
  readonly cacheDirectory?: string;
}

export interface DesktopBundle {
  readonly manifest: ManifestV1;
  readonly descriptor: Descriptor;
  readonly activate?: Activate<DesktopContext>;
}

/** A small bundle with a desktopMain part that exercises the core. */
export const probe = (
  id: string,
  options: {
    readonly requires?: readonly string[];
    /** Contracts the probe defines in desktopMain: `[id, kind]`. */
    readonly provides?: readonly (readonly [
      string,
      'command' | 'settings' | 'hooks',
    ])[];
    readonly activate?: Activate<DesktopContext>;
  } = {},
): DesktopBundle => ({
  manifest: {
    manifestVersion: 1,
    id,
    version: '1.0.0',
    engines: { doric: '^1.0.0' },
    provides: (options.provides ?? []).map(([contract]) => `${contract}@1.0.0`),
    requires: [...(options.requires ?? [])],
  },
  descriptor: {
    descriptorVersion: 1,
    bundle: { id, version: '1.0.0' },
    contracts: (options.provides ?? []).map(([contract, kind]) => ({
      id: contract,
      version: '1.0.0',
      kind,
      environment: 'desktopMain' as const,
      cardinality: 'one' as const,
      local: false,
      schema: `schemas/${contract}.json`,
    })),
  },
  ...(options.activate === undefined ? {} : { activate: options.activate }),
});

/**
 * The host-only foundation the core requires: in desktopMain its contracts
 * are provided elsewhere, which satisfies the core.
 */
const foundation: DesktopBundle = {
  manifest: {
    manifestVersion: 1,
    id: 'memory',
    version: '1.0.0',
    engines: { doric: '^1.0.0' },
    provides: ['storage.backend/v1@1.0.0', 'secrets.backend/v1@1.0.0'],
    requires: [],
  },
  descriptor: {
    descriptorVersion: 1,
    bundle: { id: 'memory', version: '1.0.0' },
    contracts: ['storage.backend/v1', 'secrets.backend/v1'].map((id) => ({
      id,
      version: '1.0.0',
      kind: 'service' as const,
      environment: 'host' as const,
      cardinality: 'one' as const,
      local: true,
      schema: `schemas/${id}.json`,
    })),
  },
};

export interface Desktop {
  /** Every call main's broker received, in arrival order. */
  readonly calls: BrokerCall[];
  /** Records the core's log/v1 wrote through doric.log/v1. */
  readonly records: LogRecord[];
  /** Bundle states after activation. */
  readonly states: Readonly<Record<string, string>>;
  /** The platform principal's services, as main's dispatch uses them. */
  readonly services: Services;
  /** A platform call, as main's lifecycle would make it. */
  call(): Call;
  /** Fires `doric.app.hooks/v1` hooks as the platform does. */
  fire(
    hook: 'onAppReadyHook' | 'onAppActivateHook',
    call?: Call,
  ): Promise<void>;
  /** The broker calls of one method, by `<contract>.<method>`. */
  received(method: string): readonly BrokerCall[];
  stop(): Promise<void>;
}

const brokerSpecs: Readonly<
  Record<
    string,
    Readonly<Record<string, { input: z.ZodType; output: z.ZodType }>>
  >
> = {
  'doric.windows/v1': {
    open: { input: openWindowRequestSchema, output: z.void() },
    focusOrOpen: { input: z.string(), output: z.void() },
    lastPath: { input: z.string(), output: z.string().nullable() },
  },
  'doric.menus/v1': {
    setSkeleton: { input: z.array(z.unknown()), output: z.void() },
    add: { input: z.record(z.string(), z.unknown()), output: z.void() },
    addKeybinding: {
      input: z.record(z.string(), z.unknown()),
      output: z.void(),
    },
    setContext: {
      input: z.record(z.string(), z.unknown()),
      output: z.void(),
    },
  },
  'doric.cache/v1': {
    directory: { input: z.tuple([]), output: z.string() },
  },
};

/**
 * One desktopMain environment in this process: the core from its build
 * (manifest and descriptor from `dist`), the given probes, the platform's
 * local providers, and a fake of main's broker (`doric.windows/v1`,
 * `doric.menus/v1`, `doric.cache/v1`), the boundary the utility process
 * reaches over its link.
 */
export const bootDesktop = async (
  bundles: readonly DesktopBundle[],
  options: BrokerOptions & {
    readonly core?: Activate<DesktopContext>;
  } = {},
): Promise<Desktop> => {
  const part = await builtDesktopPart();
  const core: DesktopBundle = {
    manifest: (await readJson('bundles/core/dist/manifest.json')) as ManifestV1,
    descriptor: (await readJson(
      'bundles/core/dist/contracts.json',
    )) as Descriptor,
    activate: options.core ?? part.activate,
  };
  const all = [core, foundation, ...bundles];
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
  const records: LogRecord[] = [];

  providePlatformServices(platform, {
    snapshot: () => catalogSnapshot(resolved, diagnostics),
    diagnostics,
    sink: { write: (record) => records.push(record) },
  });

  const calls: BrokerCall[] = [];
  const answer = (method: string, input: unknown): unknown => {
    if (method === 'doric.windows/v1.lastPath') {
      return options.lastPaths?.[input as string] ?? null;
    }

    if (method === 'doric.cache/v1.directory') {
      if (options.cacheDirectory === undefined) {
        throw new Error('This test gives the core no cache directory.');
      }

      return options.cacheDirectory;
    }

    return undefined;
  };

  for (const [contractId, methods] of Object.entries(brokerSpecs)) {
    const record: ProviderRecord = {
      contractId,
      bundleId: 'doric',
      version: PLATFORM_VERSION,
      contractVersion: '1.0.0',
      environment: 'desktopMain',
      cardinality: 'one',
      methods,
      origin: 'remote',
      invoke: async (method, input, call) => {
        const name = `${contractId}.${method}`;

        calls.push({ method: name, input, call });

        return answer(name, input);
      },
    };

    directory.register(record);
  }

  const byId = new Map(all.map((bundle) => [bundle.manifest.id, bundle]));
  const activation = await activateEnvironment({
    resolved,
    runtime,
    platform,
    diagnostics,
    loadPart: async (entry) =>
      byId.get(entry.id)?.activate as Activate | undefined,
  });
  const platformCall = () =>
    createHopCall({
      caller: platform.caller,
      generationSignal: controller.signal,
    });

  return {
    calls,
    records,
    services: platform.services,
    states: Object.fromEntries(
      diagnostics.snapshot().bundles.map(({ id, state }) => [id, state]),
    ),
    call: platformCall,
    fire: async (hook, call) => {
      const hooks = activation.appHooks();

      if (hooks === undefined) {
        throw new Error('doric.app.hooks/v1 was never defined.');
      }

      await hooks[hook].execute({}, call ?? platformCall());
    },
    received: (method) => calls.filter((entry) => entry.method === method),
    stop: async () => {
      await activation.stop();
      controller.abort();
    },
  };
};
