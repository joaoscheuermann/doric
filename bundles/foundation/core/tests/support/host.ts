import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type Descriptor,
  type EmbeddedBundle,
  type HostPlatform,
  type LogSink,
  type ManifestV1,
  type PlatformLog,
  startHost,
} from 'bundle';
import {
  type AnyServiceDefinition,
  defineMethod,
  defineService,
  type HostContext,
  isServiceDefinition,
  type LogRecord,
  type Services,
} from 'bundle/contracts';
import { type MemoryFoundationOptions, memoryFoundation } from 'storage/memory';

import { createActivate } from '../../src/host/index.js';

const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, 'utf8')) as unknown;

/**
 * The core as its build publishes it (manifest and descriptor from `dist`),
 * activated from this package's host part with the given options.
 */
export const core = async (
  options: Parameters<typeof createActivate>[0] = {},
): Promise<EmbeddedBundle> => ({
  manifest: (await readJson(
    'bundles/foundation/core/dist/manifest.json',
  )) as ManifestV1,
  descriptor: (await readJson(
    'bundles/foundation/core/dist/contracts.json',
  )) as Descriptor,
  host: { activate: createActivate(options) },
});

export type ProbeKind =
  | 'service'
  | 'hooks'
  | 'settings'
  | 'event'
  | 'storage-type';

export interface ProbeOptions {
  readonly requires?: readonly string[];
  /** Contracts the probe provides on the host: `[id, kind, version = 1.0.0]`. */
  readonly provides?: readonly (readonly [string, ProbeKind, string?])[];
  readonly activate?: (ctx: HostContext) => unknown;
}

/** A small embedded bundle that exercises the core through its contracts. */
export const probe = (
  id: string,
  options: ProbeOptions = {},
): EmbeddedBundle => {
  const provides = options.provides ?? [];

  return {
    manifest: {
      manifestVersion: 1,
      id,
      version: '1.2.3',
      engines: { doric: '^1.0.0' },
      provides: provides.map(
        ([contract, , version]) => `${contract}@${version ?? '1.0.0'}`,
      ),
      requires: [...(options.requires ?? [])],
    },
    descriptor: {
      descriptorVersion: 1,
      bundle: { id, version: '1.2.3' },
      contracts: provides.map(([contract, kind, version]) => ({
        id: contract,
        version: version ?? '1.0.0',
        kind,
        environment: 'host' as const,
        cardinality: 'one' as const,
        local: true,
        schema: `schemas/${contract}.json`,
      })),
    },
    host: {
      activate: async (ctx: HostContext) => {
        await options.activate?.(ctx);
      },
    },
  };
};

export interface Booted {
  readonly platform: HostPlatform;
  readonly records: LogRecord[];
  readonly warnings: { fields: Record<string, unknown>; message: string }[];
  close(): Promise<void>;
}

const silent: PlatformLog = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Wraps every method of a service so each call is recorded as `<contract>.<method>`. */
const spiedDefinition = (
  definition: AnyServiceDefinition,
  calls: string[],
): AnyServiceDefinition =>
  defineService(
    definition.id,
    Object.fromEntries(
      Object.entries(definition.methods).map(([name, method]) => [
        name,
        defineMethod({
          input: method.input,
          output: method.output,
          execute: (input, call, services) => {
            calls.push(`${definition.id}.${name}`);

            return method.execute(input, call, services) as never;
          },
        }),
      ]),
    ),
    definition.cardinality === 'many' ? { cardinality: 'many' } : undefined,
  );

/**
 * The same bundle, with every service it provides recorded in `calls`: the
 * backend is the database boundary, so this is how a test sees whether the
 * host reached it.
 */
export const spied = (
  bundle: EmbeddedBundle,
  calls: string[],
): EmbeddedBundle => ({
  ...bundle,
  host: {
    activate: (ctx: HostContext) => {
      const services: Services = {
        ...ctx.services,
        provide: (definition) =>
          ctx.services.provide(
            isServiceDefinition(definition)
              ? spiedDefinition(definition, calls)
              : definition,
          ),
      };

      return bundle.host?.activate?.({ services });
    },
  },
});

/** The backend choice every test composition makes. */
export const backends = {
  'storage.backend/v1': 'memory',
  'secrets.backend/v1': 'memory',
} as const;

export interface BootOptions {
  readonly sink?: LogSink;
  /** Options of the default memory foundation (bundle `memory`). */
  readonly memory?: MemoryFoundationOptions;
  /** Records every call that reaches the memory backends. */
  readonly backendCalls?: string[];
  /** Replaces the default foundation and backend choice. */
  readonly foundation?: {
    readonly bundles: readonly EmbeddedBundle[];
    readonly providers: Readonly<Record<string, string>>;
  };
  /** Further enabled bundles and choices. */
  readonly enabled?: readonly string[];
  readonly providers?: Readonly<Record<string, string>>;
}

/**
 * Boots the host with the core, the memory foundation chosen for both
 * backends, and the given bundles; no installed bundles.
 */
export const boot = async (
  embedded: readonly EmbeddedBundle[],
  options: BootOptions = {},
): Promise<Booted> => {
  const root = await mkdtemp(join(tmpdir(), 'core-test-'));
  const records: LogRecord[] = [];
  const warnings: Booted['warnings'] = [];
  const memory = memoryFoundation(options.memory);
  const foundation = options.foundation ?? {
    bundles: [
      options.backendCalls === undefined
        ? memory
        : spied(memory, options.backendCalls),
    ],
    providers: backends,
  };
  const platform = await startHost({
    bundlesPath: root,
    composition: {
      core: 'core',
      enabled: [
        'core',
        ...foundation.bundles.map(({ manifest }) => manifest.id),
        ...(options.enabled ?? []),
      ],
      providers: { ...foundation.providers, ...options.providers },
    },
    embedded: [...foundation.bundles, ...embedded],
    log: {
      ...silent,
      warn: (fields, message) => warnings.push({ fields, message }),
    },
    sink: options.sink ?? { write: (record) => records.push(record) },
  });

  return {
    platform,
    records,
    warnings,
    close: async () => {
      await platform.stop();
      await rm(root, { recursive: true, force: true });
    },
  };
};

export const states = (platform: HostPlatform) =>
  Object.fromEntries(
    platform.diagnostics().bundles.map(({ id, state }) => [id, state]),
  );

export const reasonCodes = (platform: HostPlatform, id: string) =>
  platform
    .diagnostics()
    .bundles.find((bundle) => bundle.id === id)
    ?.reasons.map(({ code }) => code);

export const errorKinds = (platform: HostPlatform) =>
  platform
    .diagnostics()
    .errors.map(({ bundleId, kind }) => `${bundleId}:${kind}`);
