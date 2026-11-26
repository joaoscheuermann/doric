import type { StreamListener } from '../contracts/basic/common.js';
import type { StorageIdentity } from '../contracts/basic/storage.js';
import type { Call } from '../contracts/call.js';
import type { Disposable } from '../contracts/context.js';
import { defineMethod, definePlatformService } from '../contracts/define.js';
import {
  type BundleState,
  type CatalogChange,
  type CatalogManifest,
  type CatalogSnapshot,
  type DiagnosticReport,
  type Diagnostics,
  type DistributionArtifact,
  type DistributionCatalog,
  DoricBundleV1,
  DoricCatalogV1,
  DoricDiagnosticsV1,
  DoricGenerationV1,
  DoricLogV1,
  type GenerationDescription,
  type LogRecord,
  type PeerSignal,
  platformContracts,
  type WorkHold,
} from '../contracts/platform.js';
import type { ResolvedEnvironment } from './catalog.js';
import type { DiagnosticsStore } from './diagnostics.js';
import type { Manifest } from './manifest.js';
import type { Principal } from './principal.js';
import { toDisposable } from './scope.js';

/** Where `doric.log/v1` records are written (the host's log files, main's log). */
export interface LogSink {
  write(record: LogRecord): void;
}

/**
 * The host-only `doric.catalog/v1` members the desktop consumes (API mínima
 * [S8-9]); the host serves them, desktopMain and client do not.
 */
export interface CatalogDistributionProvider {
  distribution(call: Call): Promise<DistributionCatalog>;
  artifact(
    request: { readonly sha256: string },
    call: Call,
  ): Promise<DistributionArtifact>;
  watch(listener: StreamListener<CatalogChange>, call: Call): Disposable;
}

/**
 * The host-only recovery members of `doric.catalog/v1` (HR-6): they change
 * the host's composition overrides and publish a new generation.
 */
export interface CatalogCompositionProvider {
  disable(request: { readonly bundleId: string }, call: Call): Promise<void>;
  resetComposition(call: Call): Promise<void>;
}

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

/** A validated manifest as `doric.catalog/v1` publishes it, copied. */
const publishedManifest = (manifest: Manifest): CatalogManifest => {
  const common = {
    id: manifest.id,
    version: manifest.version,
    engines: { doric: manifest.engines.doric },
    provides: [...manifest.provides],
  };
  const tail = {
    ...(manifest.desktopScope === undefined
      ? {}
      : {
          desktopScope: Object.fromEntries(
            Object.entries(manifest.desktopScope).map(([id, keys]) => [
              id,
              [...keys],
            ]),
          ),
        }),
    ...(manifest.description === undefined
      ? {}
      : { description: manifest.description }),
  };

  if (manifest.manifestVersion === 2) {
    return {
      manifestVersion: 2,
      ...common,
      host: {
        requires: [...manifest.host.requires],
        optional: [...manifest.host.optional],
        ...(manifest.host.httpPrefix === undefined
          ? {}
          : { httpPrefix: manifest.host.httpPrefix }),
      },
      client: {
        requires: [...manifest.client.requires],
        optional: [...manifest.client.optional],
      },
      ...tail,
    };
  }

  return {
    manifestVersion: 1,
    ...common,
    requires: [...manifest.requires],
    ...(manifest.optional === undefined
      ? {}
      : { optional: [...manifest.optional] }),
    ...tail,
    ...(manifest.host === undefined
      ? {}
      : {
          host:
            manifest.host.httpPrefix === undefined
              ? {}
              : { httpPrefix: manifest.host.httpPrefix },
        }),
  };
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
          : { manifest: publishedManifest(entry.manifest) }),
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

/**
 * Registers the platform providers of one environment under principal
 * `doric`: `doric.catalog/v1`, `doric.diagnostics/v1`, `doric.bundle/v1`,
 * `doric.log/v1` and, when given, `doric.generation/v1`. Pure: the
 * desktopMain runner and the desktop client share it.
 */
export const providePlatformServices = (
  platform: Principal,
  options: {
    /** The catalog the call sees. */
    readonly snapshot: (call: Call) => CatalogSnapshot;
    readonly diagnostics: DiagnosticsStore;
    /** The diagnostics the call sees; default the store's snapshot. */
    readonly diagnosticsFor?: (call: Call) => Diagnostics;
    readonly sink: LogSink;
    /** The host's distribution members of `doric.catalog/v1`. */
    readonly distribution?: CatalogDistributionProvider;
    /** The host's recovery members of `doric.catalog/v1`. */
    readonly composition?: CatalogCompositionProvider;
    /** `doric.generation/v1`, when the caller's environment has one. */
    readonly generation?: {
      describe(call: Call): GenerationDescription;
      hold(work: WorkHold, call: Call): Disposable;
      signal(signal: PeerSignal, call: Call): void | Promise<void>;
    };
  },
): void => {
  const { services, runtime } = platform;
  const catalog = specs['doric.catalog/v1'].methods;
  const diagnostics = specs['doric.diagnostics/v1'].methods;
  const bundle = specs['doric.bundle/v1'].methods;
  const log = specs['doric.log/v1'].methods;

  const { distribution, composition } = options;

  services.provide(
    definePlatformService(DoricCatalogV1, {
      get: defineMethod({
        input: catalog.get.input,
        output: catalog.get.output,
        execute: (_input, call) => options.snapshot(call),
      }),
      ...(distribution === undefined
        ? {}
        : {
            distribution: defineMethod({
              input: catalog.distribution.input,
              output: catalog.distribution.output,
              execute: (_input, call) => distribution.distribution(call),
            }),
            artifact: defineMethod({
              input: catalog.artifact.input,
              output: catalog.artifact.output,
              execute: (request: { readonly sha256: string }, call) =>
                distribution.artifact(request, call),
            }),
            watch: defineMethod({
              input: catalog.watch.input,
              output: catalog.watch.output,
              execute: ([listener]: [StreamListener<CatalogChange>], call) => {
                const held = distribution.watch(listener, call);

                return toDisposable(() => held.dispose());
              },
            }),
          }),
      ...(composition === undefined
        ? {}
        : {
            disable: defineMethod({
              input: catalog.disable.input,
              output: catalog.disable.output,
              execute: (request: { readonly bundleId: string }, call) =>
                composition.disable(request, call),
            }),
            resetComposition: defineMethod({
              input: catalog.resetComposition.input,
              output: catalog.resetComposition.output,
              execute: (_input, call) => composition.resetComposition(call),
            }),
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
          execute: (work: WorkHold, call) => {
            const held = generation.hold(work, call);

            return toDisposable(() => held.dispose());
          },
        }),
        signal: defineMethod({
          input: methods.signal.input,
          output: methods.signal.output,
          execute: (peer: PeerSignal, call) => generation.signal(peer, call),
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
