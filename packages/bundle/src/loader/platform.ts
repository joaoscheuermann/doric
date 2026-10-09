import type { StorageIdentity } from '../contracts/basic/storage.js';
import type { Call } from '../contracts/call.js';
import type { Disposable } from '../contracts/context.js';
import { defineMethod, definePlatformService } from '../contracts/define.js';
import {
  type BundleState,
  type CatalogSnapshot,
  type DiagnosticReport,
  type Diagnostics,
  DoricBundleV1,
  DoricCatalogV1,
  DoricDiagnosticsV1,
  DoricGenerationV1,
  DoricLogV1,
  type ExecutionRef,
  type GenerationDescription,
  type LogRecord,
  platformContracts,
} from '../contracts/platform.js';
import type { ResolvedEnvironment } from '../runtime/catalog.js';
import type { DiagnosticsStore } from '../runtime/diagnostics.js';
import type { Principal } from '../runtime/principal.js';
import { toDisposable } from '../runtime/scope.js';
import type { LogSink } from './log.js';

/** What a catalog snapshot reads of the live bundle states. */
export interface BundleStates {
  snapshot(): Diagnostics;
  state(id: string): BundleState | undefined;
}

/**
 * Bundle states from a diagnostics snapshot: like `DiagnosticsStore.state`,
 * the first bundle with an ID holds its state.
 */
export const statesOf = (diagnostics: Diagnostics): BundleStates => {
  const first = new Map<string, BundleState>();

  for (const bundle of diagnostics.bundles) {
    if (!first.has(bundle.id)) {
      first.set(bundle.id, bundle.state);
    }
  }

  return { snapshot: () => diagnostics, state: (id) => first.get(id) };
};

/**
 * The catalog snapshot `doric.catalog/v1` publishes, with live bundle states
 * and, once resolved, the storage identity.
 */
export const catalogSnapshot = (
  resolved: ResolvedEnvironment,
  diagnostics: BundleStates,
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
    /** The catalog the call sees (its operation generation's, in the kernel). */
    readonly snapshot: (call: Call) => CatalogSnapshot;
    readonly diagnostics: DiagnosticsStore;
    /** The diagnostics the call sees; default the store's snapshot. */
    readonly diagnosticsFor?: (call: Call) => Diagnostics;
    readonly sink: LogSink;
    /** The kernel's `doric.generation/v1` (absent in a single-process host). */
    readonly generation?: {
      describe(call: Call): GenerationDescription;
      hold(execution: ExecutionRef, call: Call): Disposable;
    };
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
        execute: (_input, call) => options.snapshot(call),
      }),
    }),
  );
  services.provide(
    definePlatformService(DoricDiagnosticsV1, {
      get: defineMethod({
        input: diagnostics.get.input,
        output: diagnostics.get.output,
        execute: (_input, call) =>
          options.diagnosticsFor === undefined
            ? options.diagnostics.snapshot()
            : options.diagnosticsFor(call),
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
  const { generation } = options;

  if (generation !== undefined) {
    const methods = specs['doric.generation/v1'].methods;

    services.provide(
      definePlatformService(DoricGenerationV1, {
        describe: defineMethod({
          input: methods.describe.input,
          output: methods.describe.output,
          execute: async (_input, call) => generation.describe(call),
        }),
        hold: defineMethod({
          input: methods.hold.input,
          output: methods.hold.output,
          execute: (execution: ExecutionRef, call) => {
            const held = generation.hold(execution, call);

            return toDisposable(() => held.dispose());
          },
        }),
      }),
    );
  }

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
