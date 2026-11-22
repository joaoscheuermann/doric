// The platform contracts the host process serves in process on the router
// listener (spec `docs/designs/grpc-processes.md`, section 1, "The host
// process", and section 3: steps 1 to 3, then the platform's handler). In
// phase 2 only `doric.generation/v1` and `doric.log/v1` (A65); the others
// join in phase 3.

import { randomUUID } from 'node:crypto';

import type {
  DescMessage,
  DescService,
  MessageShape,
} from '@bufbuild/protobuf';
import type { Value } from '@bufbuild/protobuf/wkt';
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

import type { Call, CallScope } from '../../contracts/call.js';
import { ContractError, toContractError } from '../../contracts/error.js';
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
import { toConnectError } from '../../contracts/status.js';
import { restoreCall } from '../../runtime/envelope/call-meta.js';
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
