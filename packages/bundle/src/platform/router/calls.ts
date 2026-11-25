// The relay of calls between bundles (spec `docs/designs/grpc-processes.md`,
// section 3, "Calls between bundles", steps 2 to 8, and section 5,
// "Host-to-bundle calls"): the router checks the call's metadata, picks the
// provider's instance and relays the payload bytes over that instance's
// control stream without decoding them (D2). Step 1, authentication, is
// `connect.ts`'s; steps 2 to 4 are `route.ts`'s.

import type { MessageInitShape } from '@bufbuild/protobuf';
import {
  assertByteStreamRequest,
  type UniversalServerRequest,
  type UniversalServerResponse,
} from '@connectrpc/connect/protocol';

import type { CallScope } from '../../contracts/call.js';
import { ContractError, toContractError } from '../../contracts/error.js';
import type {
  ConnectRequest,
  ConnectResponseSchema,
} from '../../contracts/gen/doric/platform/v1/control_pb.js';
import type { Status } from '../../contracts/gen/google/rpc/status_pb.js';
import {
  scopeFromHeader,
  scopeHeader,
  timeoutHeader,
} from '../../contracts/metadata.js';
import { toStatus } from '../../contracts/status.js';
import type { Part } from '../../runtime/manifest.js';
import type { CatalogIndex, MethodInfo } from '../catalog-index.js';
import type { Timings } from '../supervisor/timings.js';
import { createFlights, cutOff, drained, landing } from './flights.js';
import type {
  InstanceKey,
  InstanceRecord,
  InstanceTable,
} from './instances.js';
import { relayCall } from './pinned.js';
import {
  type PlatformServiceImpl,
  platformHandlers,
  servePlatform,
} from './platform-services.js';
import { createReach } from './reach.js';
import type { ReplayHold, ReplayParty } from './replay.js';
import {
  type CallRoutes,
  gatewayCaller,
  type RouteEnv,
  routeCall,
} from './route.js';
import {
  deadlineFrom,
  dropCallerHeaders,
  grpcContentType,
  pathOf,
  trailersOnly,
} from './wire.js';

/** What the relay needs of an instance's accepted control stream. */
export interface ControlChannel {
  /** The full names of the services its `Hello` listed. */
  readonly services: ReadonlySet<string>;
  /** Queues a frame for the bundle; ignored once the stream ended. */
  send(frame: MessageInitShape<typeof ConnectResponseSchema>): void;
}

/** The frames of a call that the bundle sends on its control stream. */
export type CallFrame = Extract<
  ConnectRequest['frame'],
  { case: 'callMessage' | 'callEnd' | 'callCredit' }
>;

export interface CallRelayOptions {
  readonly index: CatalogIndex;
  /** The table the relay reads to pick an instance and waits on. */
  readonly instances: InstanceTable;
  readonly routes: CallRoutes;
  /** The platform services served in process; a service at most once. */
  readonly platformServices: readonly PlatformServiceImpl[];
  /** `activeWaitMs` bounds the wait for an active instance. */
  readonly timings: Timings;
  /** The accepted control stream of an instance; `undefined` when none. */
  readonly channel: (key: InstanceKey) => ControlChannel | undefined;
}

/**
 * The calls of one router. Every call ends with a gRPC status: `OK` or the
 * provider's `CallEnd` status as it sent it, or a `ContractError` the relay
 * raised, as `toStatus` encodes it.
 */
export interface CallRelay {
  /**
   * Serves one call, authenticated as `caller` (step 1), whose request
   * reached the router listener. In order:
   *
   * - drops every request header starting with `doric-caller` and
   *   `doric-client-part`;
   * - {@link routeCall} with the part `host`; its error ends the call;
   * - `platform`: runs the method's in-process handler with the stamped
   *   `Call` (`callOf`) and the caller's record (`callerInstanceOf`);
   * - `provider`: waits until `instances.activeOf(bundleId)` answers an
   *   instance with an accepted control stream, at most until the call's
   *   deadline or, without one, `timings.activeWaitMs` (30 s); then
   *   `UNAVAILABLE`, reason `unavailable`. `target`: the instance must be
   *   `connected`, `active`, `draining` or `stopping` with an accepted
   *   control stream, otherwise `UNAVAILABLE`, reason `generation_lost`;
   * - an instance whose Hello did not list the method's service:
   *   `UNIMPLEMENTED`, reason `unknown_contract`, and no `CallStart` is sent;
   * - pins the call to the instance and sends `CallStart` with a call id
   *   unique on that stream, the path, the method's kind, the caller
   *   `{ bundleId, version, generation, incarnation }` of the token's
   *   record, the scope of `doric-scope-bin`, `deadlineUnixMs` (0 without a
   *   deadline), `initialCredit` (`initialCallCredit`), a `traceparent` with
   *   the request's trace id and a new span id (a new trace without one),
   *   and, for `unary` and `server_stream`, the request message's bytes as
   *   `payload`; for the streaming kinds the request messages follow as
   *   `CallMessage` and the end of the request as `CallHalfClose`;
   * - relays each `CallMessage` the instance sends as one response message,
   *   unchanged, and ends the call with its `CallEnd` status;
   * - at the deadline sends `CallCancel { reason: "deadline" }` and ends the
   *   call with `DEADLINE_EXCEEDED`; when the caller cancels, sends
   *   `CallCancel { reason: "cancelled" }`; the later `CallEnd` is discarded.
   *
   * A `doric-scope-bin` that does not decode ends the call with
   * `invalid_scope`. Payloads are never decoded (D2). Resolves with the
   * response at once: its body streams the response messages and its
   * trailer holds the status. Never rejects.
   */
  serve(
    caller: InstanceRecord,
    request: UniversalServerRequest,
  ): Promise<UniversalServerResponse>;
  /**
   * Serves one call the gateway relays (section 11), in-process: `request`
   * is a gRPC request (`application/grpc+proto`, enveloped binary messages)
   * whose URL path is the method's. As {@link CallRelay.serve} with the
   * caller {@link gatewayCaller}, except step 3: {@link routeCall} with the
   * part `client` and `declaredBy: clientPart`, or `declaredBy: null` when
   * `clientPart` is undefined. A `clientPart` naming a bundle that the
   * routes hold no declarations of answers `PERMISSION_DENIED`, reason
   * `undeclared_requirement`. Every `doric-caller*` and `doric-client-part`
   * request header is dropped before the provider is reached, so the
   * provider's `CallStart` names the caller `doric` and carries no client
   * part. The call counts in {@link CallRelay.inFlight} for the instance it
   * is pinned to and for `doric/0/0`. Resolves with the response at once,
   * as `serve`; never rejects.
   */
  serveGateway(
    request: UniversalServerRequest,
    clientPart: string | undefined,
  ): Promise<UniversalServerResponse>;
  /**
   * Counts a connection the gateway proxied to `key`'s HTTP prefix (an
   * upgraded connection or a proxied request, section 11) as a call in
   * flight to `key`, from `doric/0/0`, until the answered function is
   * called; that function is idempotent and, on its first call, fires
   * {@link CallRelay.onCallEnded} with `(key, 'doric/0/0')`. When
   * {@link CallRelay.cancelDrained} runs for `key`, or {@link CallRelay.close}
   * runs, `cancel` is called once and the connection stops counting, as if
   * released. A `cancel` that throws is ignored. Never throws.
   */
  trackConnection(key: InstanceKey, cancel: () => void): () => void;
  /**
   * Takes a call frame `key`'s control stream sent. Answers `false`, taking
   * nothing, for a `CallMessage` or `CallEnd` whose `callId` is not a call
   * pinned to `key` and still open, and for a `CallMessage` beyond the
   * call's credit: the listener rejects the stream with
   * `protocol_violation`. A frame of a call the relay already ended (a
   * cancelled call's `CallEnd`) answers `true` and is discarded.
   */
  receive(key: InstanceKey, frame: CallFrame): boolean;
  /**
   * The control stream of `key` ended: every call pinned to it ends with
   * `UNAVAILABLE`, reason `generation_lost`. Idempotent.
   */
  channelEnded(key: InstanceKey): void;
  /**
   * Holds the calls to `provider` for the replay of `parties` (section 4):
   * until the hold is released, a call the relay would pin to `provider`
   * waits before its `CallStart`, unless its caller is the consumer of a
   * pending party and it carries `doric-target` naming `provider`: such a
   * call (a replay) goes through at once. A pending consumer's call without
   * that `doric-target` waits as any other. A waiting
   * call still ends at its deadline or when its caller cancels, as any call;
   * on the release the waiting calls start, in the order they arrived. With
   * no party, answers a hold already released.
   *
   * `onReplayFailed` is called once per call that a pending party's consumer
   * made through the hold to `provider`, on a method of the party's `contractId`, and that
   * ended with a status other than `OK`: a replay that failed
   * (`registration_replay_failed`). A hold already taken for `provider` is
   * released first. Never throws.
   */
  holdForReplay(
    provider: InstanceKey,
    parties: readonly ReplayParty[],
    onReplayFailed: (party: ReplayParty, status: Status) => void,
  ): ReplayHold;
  /**
   * Replaces the routes of every later call (section 6, "Publish"): a call
   * that `serve` takes from now on is routed with `routes`; a call already
   * pinned, or waiting for an active instance, keeps the route it got.
   * Never throws.
   */
  setRoutes(routes: CallRoutes): void;
  /**
   * Ends at once every resumable server stream (its method's
   * `MethodInfo.resumable`) pinned to `key` and still open: sends `CallCancel
   * { reason: "drained" }` to `key` and ends the call for its caller with
   * `UNAVAILABLE`, reason `generation_lost`, so the caller opens it again on
   * the bundle's active instance (section 6, "Drain"); the later `CallEnd`
   * is discarded. Every other call is untouched. Idempotent; never throws.
   */
  endResumable(key: InstanceKey): void;
  /**
   * How many calls are in flight to or from `key`: pinned to it and not
   * ended, or made with its token and not ended, platform calls included,
   * of every kind but a resumable server stream it made (section 6,
   * "Drain"). A call waiting for an active
   * instance or for a replay counts for its caller only. 0 for a key with
   * none.
   */
  inFlight(key: InstanceKey): number;
  /**
   * Calls `listener` after every call that ends, with the instance it was
   * pinned to (`undefined` for a platform call or one that never started)
   * and the instance that made it, after {@link CallRelay.inFlight} has
   * stopped counting it. Answers the function that removes the listener. A
   * listener that throws stops neither the others nor the call's end.
   */
  onCallEnded(
    listener: (to: InstanceKey | undefined, from: InstanceKey) => void,
  ): () => void;
  /**
   * The drain deadline of `key` passed (section 6, "Drain"): every call
   * still in flight to `key` gets `CallCancel { reason: "drained" }` and
   * every call `key` made to an instance gets the same on that instance's
   * stream; each ends for its caller with `UNAVAILABLE`, reason
   * `generation_lost`, and its later `CallEnd` is discarded. A platform call
   * `key` made ends the same way for it. Afterwards
   * {@link CallRelay.inFlight} answers 0 for `key`. Never throws.
   */
  cancelDrained(key: InstanceKey): void;
  /**
   * Ends every call in flight with `UNAVAILABLE`, reason `unavailable`, and
   * every waiting call likewise; later calls to `serve` answer the same.
   */
  close(): void;
}

/** A relay over `options`; it holds no call until `serve`. */
export const createCallRelay = (options: CallRelayOptions): CallRelay => {
  const platform = platformHandlers(options.platformServices);
  let env: RouteEnv = {
    index: options.index,
    routes: options.routes,
    platformServices: new Set(
      options.platformServices.map(({ service }) => service.typeName),
    ),
  };
  const closing = new AbortController();
  const flights = createFlights(options.channel);
  const { reach, holdForReplay } = createReach(options, closing.signal);

  /**
   * A platform call, counted for its caller until its response was
   * written and its stream closed; ended with `generation_lost` when its
   * caller's drain deadline cuts it first.
   */
  const servePlatformCall = async (
    caller: InstanceRecord,
    request: UniversalServerRequest,
    method: MethodInfo,
    scope: CallScope | undefined,
    deadline: number,
  ): Promise<UniversalServerResponse> => {
    const flight = flights.track(caller, false);

    try {
      const serving = servePlatform(
        platform,
        method,
        caller,
        request,
        scope,
        deadline,
      );

      serving.catch(() => {});

      const response = await Promise.race([
        serving,
        cutOff(flight).then(() => undefined),
      ]);

      if (response === undefined) {
        flights.land(flight);

        return trailersOnly(drained(flight.from));
      }

      const { body } = response;

      if (body === undefined) {
        flights.land(flight);

        return response;
      }

      return {
        ...response,
        body: landing(body, request.signal, () => flights.land(flight)),
      };
    } catch (error) {
      flights.land(flight);
      throw error;
    }
  };

  /** `serve` and `serveGateway`: step 3 checks `part` of `declaredBy`. */
  const serveCall = async (
    caller: InstanceRecord,
    request: UniversalServerRequest,
    part: Part,
    declaredBy: string | null | undefined,
  ): Promise<UniversalServerResponse> => {
    try {
      if (closing.signal.aborted) {
        throw closing.signal.reason;
      }

      dropCallerHeaders(request.header);
      assertByteStreamRequest(request);

      const route = routeCall(
        {
          caller,
          part,
          ...(declaredBy === undefined ? {} : { declaredBy }),
          path: pathOf(request.url),
          header: request.header,
        },
        env,
      );
      const scopeValue = request.header.get(scopeHeader);
      const scope =
        scopeValue === null ? undefined : scopeFromHeader(scopeValue);
      const deadline = deadlineFrom(request.header.get(timeoutHeader));

      if (route.kind === 'platform') {
        return await servePlatformCall(
          caller,
          request,
          route.method,
          scope,
          deadline,
        );
      }

      const trailer = new Headers();

      return {
        status: 200,
        header: new Headers({ 'content-type': grpcContentType }),
        body: relayCall(
          { flights, reach },
          caller,
          request,
          route,
          scope,
          deadline,
          trailer,
        ),
        trailer,
      };
    } catch (error) {
      return trailersOnly(toStatus(toContractError(error)));
    }
  };

  return {
    setRoutes: (routes) => {
      env = { ...env, routes };
    },
    endResumable: flights.endResumable,
    inFlight: flights.inFlight,
    onCallEnded: flights.onCallEnded,
    cancelDrained: flights.cancelDrained,
    serveGateway: (request, clientPart) =>
      serveCall(gatewayCaller, request, 'client', clientPart ?? null),
    trackConnection: flights.trackConnection,
    serve: (caller, request) => serveCall(caller, request, 'host', undefined),
    receive: flights.receive,
    channelEnded: flights.channelEnded,
    holdForReplay,
    close: () => {
      if (closing.signal.aborted) {
        return;
      }

      const reason = new ContractError('unavailable', 'The router is closing.');

      closing.abort(reason);
      flights.close(toStatus(reason));
    },
  };
};
