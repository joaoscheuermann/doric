// What `createCoreServices().activate` binds: the backend, the catalog and
// `core`'s own `Call`, read by every routed service at call time.

import {
  type DescService,
  fromJson,
  type JsonValue,
  type MessageInitShape,
} from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';
import { type Client, ConnectError } from '@connectrpc/connect';
import {
  type Call,
  fromConnectError,
  type SecretsBackend,
  type StorageBackend,
} from 'bundle/contracts';
import { ProviderService } from 'bundle/contracts/gen/doric/models/provider/v1/provider_pb.js';
import {
  type CatalogSnapshot,
  CatalogService,
} from 'bundle/contracts/gen/doric/platform/catalog/v1/catalog_pb.js';
import { DiagnosticsService } from 'bundle/contracts/gen/doric/platform/diagnostics/v1/diagnostics_pb.js';
import {
  LogService as PlatformLogService,
  type WriteRequestSchema as PlatformWriteRequestSchema,
} from 'bundle/contracts/gen/doric/platform/log/v1/log_pb.js';
import { BackendService as SecretsBackendService } from 'bundle/contracts/gen/doric/secrets/backend/v1/backend_pb.js';
import { ReferenceSourceService } from 'bundle/contracts/gen/doric/secrets/v1/secrets_pb.js';
import { BackendService as StorageBackendService } from 'bundle/contracts/gen/doric/storage/backend/v1/backend_pb.js';
import type { HostContext, StampedCaller } from 'bundle/host';
import { secretsBackendClient, storageBackendClient } from 'storage/rpc';

import { type CatalogLookup, splitEntry } from '../shared/state.js';

/** What a `doric.catalog/v1.Get` snapshot tells `core`, for one generation. */
export interface CoreCatalog extends CatalogLookup {
  /** The snapshot's host generation: the active one for a generation-0 call. */
  readonly generation: number;
  /**
   * The snapshot's `order`, the bundles in activation order. Hook handlers
   * without an `order` run in it, with `doric` before every bundle. Empty
   * for a snapshot without one.
   */
  readonly order: readonly string[];
  /**
   * The bundles that provide `contractId` in the host environment, ordered
   * by `order` (activation order); a bundle that `order` does not list
   * comes after, in snapshot order. Empty for an unknown contract.
   */
  providers(contractId: string): readonly string[];
}

/** What `activate` binds; every service reads it at call time. */
export interface CoreBinding {
  readonly storageBackend: StorageBackend;
  /** `secretsBackendClient(context.services.use(SecretsBackendService))`. */
  readonly secretsBackend: SecretsBackend;
  /**
   * The catalog as `call` sees it. Cached per `call.caller.generation`, as
   * `createCoreState().catalog` is today. A failed `Get` is not kept, so the
   * next call retries. Rejects with the catalog's `ContractError`.
   */
  catalog(call: Call): Promise<CoreCatalog>;
  /**
   * `core`'s own `Call` for an in-process call of its facades, made while
   * serving `call`. Its caller is `{ bundleId: context.instance.bundleId,
   * version: '', generation: context.instance.generation }` (the facades read
   * no `version` of a non-platform caller). Scope, trace, signal and deadline
   * are `call`'s. `isCall` is true and `deadlineOf` answers `call`'s deadline.
   */
  own(call: Call): Call;
  /**
   * A client of the `ReferenceSourceService` of the instance `caller`
   * (`context.services.use(ReferenceSourceService, { target })`, `target`
   * naming that bundle, generation and incarnation).
   */
  referenceSource(caller: StampedCaller): Client<typeof ReferenceSourceService>;
  /**
   * A client of the handler service `service` (`ToolHandlerService`,
   * `HookHandlerService`) of the instance `caller`:
   * `context.services.use(service, { target: \`${bundleId}/${generation}/${incarnation}\` })`.
   * Creating it makes no call and never throws. A call fails as the router
   * ends it (an instance that is gone fails with `generation_lost` or
   * `unavailable`). A call made inside a handler inherits that call's
   * deadline, scope, trace and signal.
   */
  handler<S extends DescService>(service: S, caller: StampedCaller): Client<S>;
  /**
   * `doric.log/v1.Write` through `context.services.use(PlatformLogService)`.
   * Rejects with the call's `ContractError`.
   */
  writeLog(
    record: MessageInitShape<typeof PlatformWriteRequestSchema>,
    call: Call,
  ): Promise<void>;
  /**
   * `doric.diagnostics/v1.Report`, best effort: never rejects, and a failure
   * is dropped.
   */
  report(
    input: {
      readonly bundleId: string;
      readonly kind: string;
      readonly message: string;
      readonly details?: JsonValue;
    },
    call: Call,
  ): Promise<void>;
  /**
   * A client of `models.provider/v1` on the provider bundle `bundleId`
   * (`context.services.use(ProviderService, { provider: bundleId })`).
   * Creating it makes no call and never throws. A call inherits the
   * deadline, scope, trace and signal of the call it is made in, and fails
   * as the router ends it (`unknown_provider` when `bundleId` is not a live
   * provider).
   */
  provider(bundleId: string): Client<typeof ProviderService>;
}

const providesOf = (manifest: JsonValue | undefined): readonly string[] => {
  const provides =
    typeof manifest === 'object' &&
    manifest !== null &&
    !Array.isArray(manifest)
      ? manifest.provides
      : undefined;

  return Array.isArray(provides)
    ? provides.filter((entry) => typeof entry === 'string')
    : [];
};

/** The lookup of one `doric.catalog/v1` snapshot. */
const catalogOf = (snapshot: CatalogSnapshot | undefined): CoreCatalog => {
  const provides = new Map<string, ReadonlyMap<string, string>>(
    (snapshot?.bundles ?? []).map((bundle) => [
      bundle.id,
      new Map(providesOf(bundle.manifest).map(splitEntry)),
    ]),
  );
  const active = new Map<string, string>();

  for (const contract of snapshot?.contracts ?? []) {
    const provider = contract.providers[0];

    if (contract.environment === 'host' && provider !== undefined) {
      active.set(contract.id, provider.bundleId);
    }
  }

  return {
    generation: snapshot?.generation ?? 0,
    order: snapshot?.order ?? [],
    provides: (bundleId) => provides.get(bundleId) ?? new Map(),
    activeProvider: (contractId) => active.get(contractId),
    providers: (contractId) => {
      const contract = snapshot?.contracts.find(
        ({ id, environment }) => id === contractId && environment === 'host',
      );
      const order = snapshot?.order ?? [];
      const rank = (bundleId: string) => {
        const index = order.indexOf(bundleId);

        return index < 0 ? order.length : index;
      };

      // A stable sort keeps snapshot order among the bundles `order` omits.
      return (contract?.providers ?? [])
        .map(({ bundleId }) => bundleId)
        .sort((left, right) => rank(left) - rank(right));
    },
  };
};

/** Binds `core`'s routed services to `context`. Does no I/O. */
export const createBinding = (context: HostContext): CoreBinding => {
  const catalogs = new Map<number, Promise<CoreCatalog>>();
  const catalogClient = context.services.use(CatalogService);
  const platformLog = context.services.use(PlatformLogService);
  const diagnostics = context.services.use(DiagnosticsService);
  const { instance } = context;

  return {
    storageBackend: storageBackendClient(
      context.services.use(StorageBackendService),
    ),
    secretsBackend: secretsBackendClient(
      context.services.use(SecretsBackendService),
    ),
    referenceSource: (caller) =>
      context.services.use(ReferenceSourceService, {
        target: `${caller.bundleId}/${caller.generation}/${caller.incarnation}`,
      }),
    handler: (service, caller) =>
      context.services.use(service, {
        target: `${caller.bundleId}/${caller.generation}/${caller.incarnation}`,
      }),
    provider: (bundleId) =>
      context.services.use(ProviderService, { provider: bundleId }),
    writeLog: async (record, call) => {
      try {
        await platformLog.write(record, { signal: call.signal });
      } catch (error) {
        throw error instanceof ConnectError ? fromConnectError(error) : error;
      }
    },
    report: async (input, call) => {
      try {
        await diagnostics.report(
          {
            bundleId: input.bundleId,
            kind: input.kind,
            message: input.message,
            ...(input.details === undefined
              ? {}
              : { details: fromJson(ValueSchema, input.details) }),
          },
          { signal: call.signal },
        );
      } catch {
        // Best effort: a report that cannot be made is dropped.
      }
    },
    catalog: (call) => {
      const generation = call.caller.generation;
      const cached = catalogs.get(generation);

      if (cached !== undefined) {
        return cached;
      }

      const pending = catalogClient.get({}, { signal: call.signal }).then(
        ({ catalogSnapshot }) => catalogOf(catalogSnapshot),
        (error: unknown) => {
          throw error instanceof ConnectError ? fromConnectError(error) : error;
        },
      );

      catalogs.set(generation, pending);
      void pending.catch(() => {
        if (catalogs.get(generation) === pending) {
          catalogs.delete(generation);
        }
      });

      return pending;
    },
    own: (call) => {
      const own = Object.create(call) as Call;
      const caller = Object.freeze({
        bundleId: instance.bundleId,
        version: '',
        generation: instance.generation,
      });

      // The brand and the deadline stay `call`'s, through the prototype.
      Object.defineProperties(own, {
        caller: { value: caller, enumerable: true },
        signal: { value: call.signal, enumerable: true },
        trace: { value: call.trace, enumerable: true },
        ...(call.scope === undefined
          ? {}
          : { scope: { value: call.scope, enumerable: true } }),
      });

      return Object.freeze(own);
    },
  };
};
