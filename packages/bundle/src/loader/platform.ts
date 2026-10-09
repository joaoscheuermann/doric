import type { StorageIdentity } from '../contracts/basic/storage.js';
import { defineMethod, definePlatformService } from '../contracts/define.js';
import {
  type CatalogSnapshot,
  type DiagnosticReport,
  DoricBundleV1,
  DoricCatalogV1,
  DoricDiagnosticsV1,
  DoricLogV1,
  type LogRecord,
  platformContracts,
} from '../contracts/platform.js';
import type { ResolvedEnvironment } from '../runtime/catalog.js';
import type { DiagnosticsStore } from '../runtime/diagnostics.js';
import type { Principal } from '../runtime/principal.js';
import type { LogSink } from './log.js';

/**
 * The catalog snapshot `doric.catalog/v1` publishes, with live bundle states
 * and, once resolved, the storage identity.
 */
export const catalogSnapshot = (
  resolved: ResolvedEnvironment,
  diagnostics: DiagnosticsStore,
  storage?: StorageIdentity,
): CatalogSnapshot => {
  const states = diagnostics.snapshot().bundles;

  return {
    generation: resolved.generation,
    composition: {
      core: resolved.composition.core,
      enabled: [...resolved.composition.enabled],
      providers: { ...resolved.composition.providers },
    },
    bundles: resolved.entries.map((entry, index) => {
      const live = states[index];

      return {
        id: entry.id,
        version: entry.version,
        ...(entry.description === undefined
          ? {}
          : { description: entry.description }),
        state: live?.state ?? 'inactive',
        ...(entry.phase === undefined ? {} : { phase: entry.phase }),
        ...(entry.manifest === undefined
          ? {}
          : {
              manifest: {
                manifestVersion: entry.manifest.manifestVersion,
                id: entry.manifest.id,
                version: entry.manifest.version,
                engines: { doric: entry.manifest.engines.doric },
                provides: [...entry.manifest.provides],
                requires: [...entry.manifest.requires],
                ...(entry.manifest.description === undefined
                  ? {}
                  : { description: entry.manifest.description }),
              },
            }),
        reasons: [...(live?.reasons ?? entry.reasons)],
      };
    }),
    order: [...resolved.order],
    // Only consistent entries: a provider quarantined during activation leaves
    // the contract, and a `one` contract never falls back to another (D-21).
    contracts: resolved.contracts.map((contract) => ({
      id: contract.id,
      environment: contract.environment,
      cardinality: contract.cardinality,
      providers: contract.providers
        .filter(
          (provider) => diagnostics.state(provider.bundleId) !== 'quarantined',
        )
        .map((provider) => ({ ...provider })),
    })),
    ...(storage === undefined ? {} : { storage: { ...storage } }),
  };
};

const specs = platformContracts;

/** Registers the host's platform providers under principal `doric`. */
export const providePlatformServices = (
  platform: Principal,
  options: {
    readonly snapshot: () => CatalogSnapshot;
    readonly diagnostics: DiagnosticsStore;
    readonly sink: LogSink;
  },
): void => {
  const { services, runtime } = platform;
  const catalog = specs['doric.catalog/v1'].methods;
  const diagnostics = specs['doric.diagnostics/v1'].methods;
  const bundle = specs['doric.bundle/v1'].methods;
  const log = specs['doric.log/v1'].methods;

  services.provide(
    definePlatformService(DoricCatalogV1, {
      get: defineMethod({
        input: catalog.get.input,
        output: catalog.get.output,
        execute: () => options.snapshot(),
      }),
    }),
  );
  services.provide(
    definePlatformService(DoricDiagnosticsV1, {
      get: defineMethod({
        input: diagnostics.get.input,
        output: diagnostics.get.output,
        execute: () => options.diagnostics.snapshot(),
      }),
      report: defineMethod({
        input: diagnostics.report.input,
        output: diagnostics.report.output,
        execute: (entry: DiagnosticReport) => {
          options.diagnostics.report(entry);
        },
      }),
    }),
  );
  services.provide(
    definePlatformService(DoricBundleV1, {
      describe: defineMethod({
        input: bundle.describe.input,
        output: bundle.describe.output,
        execute: (_input, call) => ({
          bundleId: call.caller.bundleId,
          version: call.caller.version,
          generation: call.caller.generation,
          environment: runtime.environment,
        }),
      }),
    }),
  );
  services.provide(
    definePlatformService(DoricLogV1, {
      write: defineMethod({
        input: log.write.input,
        output: log.write.output,
        execute: (record: LogRecord) => {
          options.sink.write(record);
        },
      }),
    }),
  );
};
