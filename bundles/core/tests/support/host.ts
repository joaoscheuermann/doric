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
import type { HostContext, LogRecord } from 'bundle/contracts';

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
  manifest: (await readJson('bundles/core/dist/manifest.json')) as ManifestV1,
  descriptor: (await readJson(
    'bundles/core/dist/contracts.json',
  )) as Descriptor,
  host: { activate: createActivate(options) },
});

export interface ProbeOptions {
  readonly requires?: readonly string[];
  /** Contracts the probe provides: `[id, kind]`, all at 1.0.0 on the host. */
  readonly provides?: readonly (readonly [string, 'service' | 'hooks'])[];
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
      provides: provides.map(([contract]) => `${contract}@1.0.0`),
      requires: [...(options.requires ?? [])],
    },
    descriptor: {
      descriptorVersion: 1,
      bundle: { id, version: '1.2.3' },
      contracts: provides.map(([contract, kind]) => ({
        id: contract,
        version: '1.0.0',
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

/** Boots the host with the core and the given bundles, no installed bundles. */
export const boot = async (
  embedded: readonly EmbeddedBundle[],
  options: { readonly sink?: LogSink } = {},
): Promise<Booted> => {
  const root = await mkdtemp(join(tmpdir(), 'core-test-'));
  const records: LogRecord[] = [];
  const warnings: Booted['warnings'] = [];
  const platform = await startHost({
    bundlesPath: root,
    composition: { core: 'core', enabled: ['core'], providers: {} },
    embedded,
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
