// The platform contracts the host process serves in process on the router
// listener (spec `docs/designs/grpc-processes.md`, section 1, "The host
// process", and section 3: steps 1 to 3, then the platform's handler). In
// phase 2 `doric.generation/v1` and `doric.log/v1`; from phase 3 also
// `doric.catalog/v1`, `doric.diagnostics/v1` and `doric.bundle/v1` (A65).

import { randomUUID } from 'node:crypto';

import {
  type DescMessage,
  type DescService,
  fromJson,
  type JsonObject,
  type JsonValue,
  type MessageInitShape,
  type MessageShape,
  toJson,
} from '@bufbuild/protobuf';
import { type Value, ValueSchema } from '@bufbuild/protobuf/wkt';
import { createValidator } from '@bufbuild/protovalidate';
import {
  ConnectError,
  type ContextKey,
  createConnectRouter,
  createContextKey,
  createContextValues,
  type HandlerContext,
  type Interceptor,
  type ServiceImpl,
} from '@connectrpc/connect';
import type {
  UniversalHandler,
  UniversalServerRequest,
  UniversalServerResponse,
} from '@connectrpc/connect/protocol';

import type { StorageIdentity } from '../../contracts/basic/storage.js';
import type { Call, CallScope } from '../../contracts/call.js';
import { ContractError, toContractError } from '../../contracts/error.js';
import { BundleService } from '../../contracts/gen/doric/platform/bundle/v1/bundle_pb.js';
import {
  CatalogService,
  type CatalogSnapshotSchema,
} from '../../contracts/gen/doric/platform/catalog/v1/catalog_pb.js';
import {
  DiagnosticsService,
  ReportRequestSchema,
} from '../../contracts/gen/doric/platform/diagnostics/v1/diagnostics_pb.js';
import {
  GenerationService,
  HoldRequestSchema,
  ReleaseRequestSchema,
  SignalRequestSchema,
} from '../../contracts/gen/doric/platform/generation/v1/generation_pb.js';
import {
  LogService,
  type WriteRequest,
  WriteRequestSchema,
} from '../../contracts/gen/doric/platform/log/v1/log_pb.js';
import { callContextKey, callOf } from '../../contracts/metadata.js';
import type {
  CatalogSnapshot,
  DiagnosticBundle,
} from '../../contracts/platform.js';
import { toConnectError } from '../../contracts/status.js';
import type { ResolvedEnvironment } from '../../runtime/catalog.js';
import type { DiagnosticsStore } from '../../runtime/diagnostics.js';
import { restoreCall } from '../../runtime/envelope/call-meta.js';
import {
  type BundleStates,
  catalogSnapshot,
} from '../../runtime/platform-providers.js';
import type { MethodInfo } from '../catalog-index.js';
import { maxMessageBytes } from './control.js';
import {
  type InstanceKey,
  type InstanceRecord,
  type InstanceTable,
  instanceKey,
} from './instances.js';
import { traceOf } from './wire.js';

/**
 * A platform contract's service and its in-process implementation. The
 * router serves every method of `service` after steps 1 to 3 of section 3
 * (authentication, contract, declaration; a `doric.*` contract passes the
 * declaration check for every caller), without an instance, pin or
 * `CallStart`. The handler finds the stamped `Call` with `callOf(context)`
 * (`contracts/metadata.ts`) and the calling instance with
 * {@link callerInstanceOf}. A handler that throws a `ContractError` ends the
 * call with its status (`toConnectError`); any other error ends it with
 * `internal`.
 */
export interface PlatformServiceImpl<S extends DescService = DescService> {
  readonly service: S;
  readonly implementation: ServiceImpl<S>;
}

/**
 * The key under which the router puts the calling instance's record, as the
 * token named it when the call arrived, in `HandlerContext.values`.
 */
export const callerInstanceKey: ContextKey<InstanceRecord | undefined> =
  createContextKey<InstanceRecord | undefined>(undefined, {
    description: 'doric.caller.instance',
  });

/**
 * The instance that made the call a platform handler serves, with its
 * incarnation, which the `Call`'s caller does not carry. Throws a
 * `TypeError` for a context the router did not fill.
 */
export const callerInstanceOf = (context: HandlerContext): InstanceRecord => {
  const record = context.values.get(callerInstanceKey);

  if (record === undefined) {
    throw new TypeError('The handler context holds no calling instance.');
  }

  return record;
};

const validator = createValidator();

/** `message`, when it follows its proto's rules; `invalid_input` otherwise. */
const validated = <Desc extends DescMessage>(
  schema: Desc,
  message: MessageShape<Desc>,
): MessageShape<Desc> => {
  const result = validator.validate(schema, message);

  if (result.kind !== 'valid') {
    throw new ContractError('invalid_input', result.error.message);
  }

  return message;
};

/** A work hold of `doric.generation/v1`. */
export interface WorkHold {
  /** The id `Hold` answered: unique within the host process. */
  readonly holdId: string;
  /** The `key` of the `HoldRequest`, opaque to the platform. */
  readonly key: string;
  /** The `label` of the `HoldRequest`, when it had one. */
  readonly label?: string;
}

export interface GenerationServiceOptions {
  /** The table whose records `Describe` answers and whose ends end holds. */
  readonly instances: InstanceTable;
  /**
   * Delivers `PeerSignal { topic, payload }` to every other live instance of
   * `from`'s bundle and to no other bundle. Must not throw.
   */
  readonly signal: (
    from: InstanceRecord,
    topic: string,
    payload: Value | undefined,
  ) => void;
}

/** `doric.generation/v1` and the holds it keeps, for the drain check. */
export interface GenerationPlatformService
  extends PlatformServiceImpl<typeof GenerationService> {
  /**
   * The holds an instance has now, in the order they were taken; empty for
   * an instance with none or not in the table.
   */
  holdsOf(key: InstanceKey): readonly WorkHold[];
}

/**
 * The in-process `doric.generation/v1`. Every method concerns the calling
 * instance ({@link callerInstanceOf}), never one the request names:
 *
 * - `Describe` answers its generation, incarnation and state, the table's
 *   state mapped as `spawned` and `connected` → `starting`, `active` →
 *   `active`, `draining` and `stopping` → `draining`, `stopped` → `stopped`,
 *   `lost` and `invalid` → `failed`;
 * - `Hold` takes a hold for it and answers its `holdId`;
 * - `Release` ends one of its holds; an unknown id, or another instance's, is
 *   a no-op that still succeeds;
 * - `Signal` calls `options.signal` with it, the topic and the payload.
 *
 * Every hold of an instance ends when the table sets it `stopped`, `lost` or
 * `invalid`. Requests are validated as the proto's rules say (`invalid_input`
 * otherwise).
 */
export const createGenerationService = (
  options: GenerationServiceOptions,
): GenerationPlatformService => {
  const holds = new Map<InstanceKey, WorkHold[]>();

  options.instances.subscribe((record) => {
    if (endedStates.has(record.state)) {
      holds.delete(instanceKey(record));
    }
  });

  return {
    service: GenerationService,
    implementation: {
      describe: (_request, context) => {
        const caller = callerInstanceOf(context);
        const record = options.instances.get(instanceKey(caller)) ?? caller;

        return {
          generation: record.generation,
          incarnation: record.incarnation,
          state: describedStates[record.state],
        };
      },
      hold: (request, context) => {
        const { key, label } = validated(HoldRequestSchema, request);
        const caller = instanceKey(callerInstanceOf(context));
        const hold: WorkHold = {
          holdId: randomUUID(),
          key,
          ...(label === undefined ? {} : { label }),
        };

        holds.set(caller, [...(holds.get(caller) ?? []), hold]);

        return { holdId: hold.holdId };
      },
      release: (request, context) => {
        const { holdId } = validated(ReleaseRequestSchema, request);
        const caller = instanceKey(callerInstanceOf(context));
        const kept = (holds.get(caller) ?? []).filter(
          (hold) => hold.holdId !== holdId,
        );

        if (kept.length === 0) {
          holds.delete(caller);
        } else {
          holds.set(caller, kept);
        }

        return {};
      },
      signal: (request, context) => {
        const { topic, payload } = validated(SignalRequestSchema, request);

        options.signal(callerInstanceOf(context), topic, payload);

        return {};
      },
    },
    holdsOf: (key) => holds.get(key) ?? [],
  };
};

/** The table's states whose instance has no holds any more. */
const endedStates: ReadonlySet<InstanceRecord['state']> = new Set([
  'stopped',
  'lost',
  'invalid',
]);

/** The table's states as `DescribeResponse.state` names them. */
const describedStates: Readonly<Record<InstanceRecord['state'], string>> = {
  spawned: 'starting',
  connected: 'starting',
  active: 'active',
  draining: 'draining',
  stopping: 'draining',
  stopped: 'stopped',
  lost: 'failed',
  invalid: 'failed',
};

export interface LogServiceOptions {
  /**
   * Writes one record to the platform's log files. `call` is the stamped
   * call: the record's own `bundleId`, `version` and `generation` name the
   * bundle the record is about, which a `log/v1` provider writing for
   * another bundle sets to that bundle, so they are kept as sent. Must not
   * throw.
   */
  readonly write: (record: WriteRequest, call: Call) => void;
}

/**
 * The in-process `doric.log/v1`: `Write` validates the request as the
 * proto's rules say (`invalid_input` otherwise), passes it to
 * `options.write`, and answers `WriteResponse {}`. A valid record is never
 * refused for its content.
 */
export const createLogService = (
  options: LogServiceOptions,
): PlatformServiceImpl<typeof LogService> => ({
  service: LogService,
  implementation: {
    write: (request, context) => {
      options.write(validated(WriteRequestSchema, request), callOf(context));

      return {};
    },
  },
});

export interface CatalogServiceOptions {
  /**
   * The resolution the host runs now: the boot's `PlatformOptions.resolved`,
   * then each one a publish adopts (`PublishTarget.adopt`). Read at every
   * call. Must not throw.
   */
  readonly resolved: () => ResolvedEnvironment;
  /**
   * Where the supervisor records each bundle's state and quarantine reasons
   * (`PlatformOptions.diagnostics`). Read at every call.
   */
  readonly diagnostics: Pick<DiagnosticsStore, 'snapshot' | 'state'>;
  /**
   * The host's storage identity once the platform has read it
   * (`storage.backend/v1.Identity` under the caller `doric`); undefined
   * before that, or when no bundle provides `storage.backend/v1`. Must not
   * throw.
   */
  readonly storage: () => StorageIdentity | undefined;
}

/**
 * The in-process `doric.catalog/v1`. `Get` answers the snapshot of
 * `options.resolved()`, the same value the kernel answers today
 * (`catalogSnapshot` in `runtime/platform-providers.ts`): generation,
 * composition, order and contracts are the resolution's; each bundle's state
 * and reasons are the ones the diagnostics hold for its id, a bundle the
 * diagnostics do not hold is `inactive` with the resolution's reasons; a
 * contract's providers leave out every bundle whose state is `quarantined`;
 * `storage` is `options.storage()`, absent while undefined. Every call reads
 * the present state. `Get` never fails for the host's state.
 * `Distribution`, `ReadArtifact`, `Watch`, `Disable` and `ResetComposition`
 * end with `UNIMPLEMENTED`, reason `unknown_contract`, until the slices that
 * serve them.
 */
export const createCatalogService = (
  options: CatalogServiceOptions,
): PlatformServiceImpl<typeof CatalogService> => ({
  service: CatalogService,
  implementation: {
    get: () => {
      const resolved = options.resolved();
      const snapshot = catalogSnapshot(
        resolved,
        statesById(resolved, options.diagnostics),
        options.storage(),
      );

      return { catalogSnapshot: snapshotMessage(snapshot) };
    },
    distribution: () => notServed('Distribution'),
    readArtifact: () => notServed('ReadArtifact'),
    watch: () => notServed('Watch'),
    disable: () => notServed('Disable'),
    resetComposition: () => notServed('ResetComposition'),
  },
});

/** `snapshot` as the `doric.catalog/v1.CatalogSnapshot` message. */
const snapshotMessage = (
  snapshot: CatalogSnapshot,
): MessageInitShape<typeof CatalogSnapshotSchema> => ({
  generation: snapshot.generation,
  composition: {
    core: snapshot.composition.core,
    enabled: [...snapshot.composition.enabled],
    providers: { ...snapshot.composition.providers },
  },
  bundles: snapshot.bundles.map(({ manifest, reasons, ...bundle }) => ({
    ...bundle,
    ...(manifest === undefined ? {} : { manifest: jsonObjectOf(manifest) }),
    reasons: reasons.map((reason) => ({ ...reason })),
  })),
  order: [...snapshot.order],
  contracts: snapshot.contracts.map(({ providers, ...contract }) => ({
    ...contract,
    providers: providers.map((provider) => ({ ...provider })),
  })),
  ...(snapshot.storage === undefined ? {} : { storage: snapshot.storage }),
});

/**
 * `value` as JSON, as `JSON.stringify` would write it: object members whose
 * value JSON cannot hold are left out, and so become array items `null`.
 */
const jsonOf = (value: unknown): JsonValue => {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => jsonOf(item));
  }

  return typeof value === 'object' ? jsonObjectOf(value) : null;
};

/** The members of `value` JSON can hold, as a JSON object. */
const jsonObjectOf = (value: object): JsonObject => {
  const json: JsonObject = {};

  for (const [key, member] of Object.entries(value)) {
    if (member !== undefined && typeof member !== 'function') {
      json[key] = jsonOf(member);
    }
  }

  return json;
};

/**
 * The diagnostics' states lined up with `resolved.entries` by bundle id, for
 * `catalogSnapshot`, which reads them by position: a bundle the diagnostics
 * do not hold is `inactive` with the resolution's reasons.
 */
const statesById = (
  resolved: ResolvedEnvironment,
  diagnostics: Pick<DiagnosticsStore, 'snapshot' | 'state'>,
): BundleStates => {
  const snapshot = diagnostics.snapshot();
  const held = new Map<string, DiagnosticBundle>();

  for (const bundle of snapshot.bundles) {
    if (!held.has(bundle.id)) {
      held.set(bundle.id, bundle);
    }
  }

  const bundles = resolved.entries.map(
    (entry): DiagnosticBundle =>
      held.get(entry.id) ?? {
        id: entry.id,
        version: entry.version,
        state: 'inactive',
        reasons: [...entry.reasons],
      },
  );

  return {
    snapshot: () => ({ ...snapshot, bundles }),
    state: (id) => diagnostics.state(id),
  };
};

/** Ends a method no slice serves yet: `UNIMPLEMENTED`, `unknown_contract`. */
const notServed = (method: string): never => {
  throw toConnectError(
    new ContractError(
      'unknown_contract',
      `doric.catalog/v1 does not serve ${method} yet.`,
    ),
  );
};

export interface DiagnosticsServiceOptions {
  /** The platform's diagnostics (`PlatformOptions.diagnostics`). */
  readonly diagnostics: Pick<DiagnosticsStore, 'snapshot' | 'report'>;
}

/**
 * The in-process `doric.diagnostics/v1`: `Get` answers
 * `options.diagnostics.snapshot()` as it is at the call (generation, mode,
 * recovery reason in recovery mode, issues, bundles, recent errors at most
 * `DIAGNOSTIC_ERRORS_PER_BUNDLE` per bundle, consumers of each contract).
 * `Report` validates the request as the proto's rules say (`invalid_input`
 * otherwise), records `{ bundleId, kind, message, details }` with
 * `options.diagnostics.report` exactly as sent (`bundleId` need not be the
 * caller), answers `ReportResponse {}`, so the next `Get` lists it. Neither
 * fails for the content of a valid request.
 */
export const createDiagnosticsService = (
  options: DiagnosticsServiceOptions,
): PlatformServiceImpl<typeof DiagnosticsService> => ({
  service: DiagnosticsService,
  implementation: {
    get: () => {
      const snapshot = options.diagnostics.snapshot();

      return {
        generation: snapshot.generation,
        mode: snapshot.mode,
        ...(snapshot.recovery === undefined
          ? {}
          : { recovery: { reason: snapshot.recovery.reason } }),
        issues: [...snapshot.issues],
        bundles: snapshot.bundles.map((bundle) => ({
          ...bundle,
          reasons: bundle.reasons.map((reason) => ({ ...reason })),
        })),
        errors: snapshot.errors.map(({ details, ...error }) => ({
          ...error,
          ...(details === undefined
            ? {}
            : { details: fromJson(ValueSchema, jsonOf(details)) }),
        })),
        consumers: Object.fromEntries(
          Object.entries(snapshot.consumers).map(([contract, bundleIds]) => [
            contract,
            { bundleIds: [...bundleIds] },
          ]),
        ),
      };
    },
    report: (request) => {
      const { bundleId, kind, message, details } = validated(
        ReportRequestSchema,
        request,
      );

      options.diagnostics.report({
        bundleId,
        kind,
        message,
        ...(details === undefined
          ? {}
          : { details: toJson(ValueSchema, details) }),
      });

      return {};
    },
  },
});

/**
 * The in-process `doric.bundle/v1`. `Describe` answers the calling instance
 * as the router stamped it (`callOf(context).caller`): `bundleId`,
 * `version`, `generation`, and the environment `"host"`. A forged
 * `doric-caller` header does not change it. Never fails.
 */
export const createBundleService = (): PlatformServiceImpl<
  typeof BundleService
> => ({
  service: BundleService,
  implementation: {
    describe: (_request, context) => {
      const { bundleId, version, generation } = callOf(context).caller;

      return { bundleId, version, generation, environment: 'host' };
    },
  },
});

/** The in-process handlers of the platform services, by gRPC path. */
export const platformHandlers = (
  services: readonly PlatformServiceImpl[],
): ReadonlyMap<string, UniversalHandler> => {
  const router = createConnectRouter({
    grpc: true,
    connect: false,
    grpcWeb: false,
    readMaxBytes: maxMessageBytes,
    writeMaxBytes: maxMessageBytes,
    interceptors: [contractErrors],
  });

  for (const { service, implementation } of services) {
    router.service(service, implementation);
  }

  return new Map(
    router.handlers.map((handler) => [handler.requestPath, handler]),
  );
};

/** Ends a platform handler's call with its error's status (`toConnectError`). */
const contractErrors: Interceptor = (next) => async (request) => {
  try {
    return await next(request);
  } catch (error) {
    throw error instanceof ConnectError
      ? error
      : toConnectError(toContractError(error));
  }
};

/** Runs a platform method in process with the stamped `Call`. */
export const servePlatform = (
  handlers: ReadonlyMap<string, UniversalHandler>,
  method: MethodInfo,
  caller: InstanceRecord,
  request: UniversalServerRequest,
  scope: CallScope | undefined,
  deadline: number,
): Promise<UniversalServerResponse> => {
  const handler = handlers.get(method.path);

  if (handler === undefined) {
    throw new ContractError(
      'unknown_contract',
      `No contract serves ${method.path}.`,
    );
  }

  const call = restoreCall(
    {
      caller: {
        bundleId: caller.bundleId,
        version: caller.version,
        generation: caller.generation,
      },
      ...(scope === undefined ? {} : { scope }),
      trace: traceOf(request.header),
      deadline,
      generation: 0,
    },
    { signals: [request.signal] },
  );
  const contextValues = createContextValues()
    .set(callContextKey, call)
    .set(callerInstanceKey, caller);

  return handler({ ...request, contextValues });
};
