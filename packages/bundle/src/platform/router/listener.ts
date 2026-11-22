// The router listener (spec `docs/designs/grpc-processes.md`, sections 2, 3
// and 5): gRPC over cleartext HTTP/2 on loopback, serving the control stream
// `doric.platform.v1.BundleHostService/Connect` and every method of the
// catalog index, relayed without decoding (D2).

import type { Value } from '@bufbuild/protobuf/wkt';
import type { ConnectRouter } from '@connectrpc/connect';
import type {
  UniversalServerRequest,
  UniversalServerResponse,
} from '@connectrpc/connect/protocol';
import {
  type ConnectNodeAdapterOptions,
  connectNodeAdapter,
  universalRequestFromNodeRequest,
  universalResponseToNodeResponse,
} from '@connectrpc/connect-node';

import { ContractError, toContractError } from '../../contracts/error.js';
import { BundleHostService } from '../../contracts/gen/doric/platform/v1/control_pb.js';
import type { Status } from '../../contracts/gen/google/rpc/status_pb.js';
import { toStatus } from '../../contracts/status.js';
import type { CatalogIndex } from '../catalog-index.js';
import {
  timings as platformTimings,
  type Timings,
} from '../supervisor/timings.js';
import { defaultRouterAddress, listen, parseAddress } from './bind.js';
import { createCallRelay } from './calls.js';
import { authenticate, serveControl } from './connect.js';
import {
  type GenerationEvent,
  type InvalidReason,
  maxMessageBytes,
  type RouterDiagnostics,
  type StreamEnd,
} from './control.js';
import { type Drain, drainInstance } from './drain.js';
import {
  type InstanceKey,
  type InstanceRecord,
  type InstanceTable,
  instanceKey,
} from './instances.js';
import type { PlatformServiceImpl } from './platform-services.js';
import { createReplayCoordinator } from './replay.js';
import type { CallRoutes } from './route.js';
import {
  announce,
  type ControlStream,
  type StreamEnv,
  signalPeers,
} from './stream.js';
import { trailersOnly } from './wire.js';

export interface RouterOptions {
  /**
   * `DORIC_ROUTER_ADDRESS`, `<host>:<port>`; {@link defaultRouterAddress}
   * when undefined. Port 0 binds a free port.
   */
  readonly address?: string;
  /** The methods the router serves besides the control stream. */
  readonly index: CatalogIndex;
  /**
   * What the router reads of the resolved catalog to route a call (section
   * 3, steps 3 and 4): each caller's declarations and each contract's
   * providers; `callRoutesOf(resolved)` builds it. Undefined: no bundle
   * declares or provides anything, so every authenticated call to a bundle
   * contract answers `PERMISSION_DENIED`, reason `undeclared_requirement`.
   * The services an instance serves are not here: the router takes them
   * from its Hello.
   */
  readonly routes?: CallRoutes;
  /**
   * The platform contracts the host serves in process (A65: in phase 2
   * `doric.generation/v1` and `doric.log/v1`), each service at most once.
   * Undefined: none, so a call to a `doric.*` contract answers
   * `UNIMPLEMENTED`, reason `unknown_contract`.
   */
  readonly platformServices?: readonly PlatformServiceImpl[];
  /**
   * The instances and their tokens. The router reads it to authenticate and
   * sets the states it observes (see {@link Router}); the supervisor issues
   * the tokens and sets every other state.
   */
  readonly instances: InstanceTable;
  readonly diagnostics: RouterDiagnostics;
  /** The platform's `timings` when undefined; tests pass shorter ones. */
  readonly timings?: Timings;
  /**
   * The router declared an instance invalid: it set the state `invalid`,
   * sent `Rejected` when the cause was a rejected Hello or a protocol
   * violation, and closed the stream. `message` names the cause, starting
   * with the `Rejected` reason when there is one (`hello_mismatch`,
   * `unsupported_protocol`, `protocol_violation`). Called once per instance.
   * The supervisor kills the process and quarantines the bundle.
   */
  readonly onInvalid: (
    key: InstanceKey,
    reason: InvalidReason,
    message: string,
  ) => void;
  /**
   * The control stream of a `connected`, `active` or `draining` instance
   * ended without `Stop`: the router set the state `lost`, ended the calls
   * pinned to it, and sent `GenerationChanged { event: "lost" }` to the
   * other live instances of its bundle as {@link Router.announce} does,
   * without waiting for their acks (section 7, "Crashes", step 2). Called
   * once per instance, never for an instance already `invalid`.
   */
  readonly onLost: (key: InstanceKey, end: StreamEnd) => void;
}

/**
 * Where the gateway sends a bundle's HTTP prefix (section 11, "The HTTP
 * prefix"): an instance and the loopback port its accepted Hello reported
 * in `httpPort`.
 */
export interface HttpTarget {
  readonly key: InstanceKey;
  /** The `httpPort` of the instance's Hello; never 0. */
  readonly port: number;
}

/**
 * A running router listener. The states it sets in the instance table:
 * `connected` when it answers a Hello with `Accepted`, `active` when an
 * `ActivateResult` has code 0, `stopping` when it sends `Stop`, `invalid`
 * ({@link RouterOptions.onInvalid}), `lost` ({@link RouterOptions.onLost}) and
 * `draining` ({@link Router.drain}).
 *
 * Every RPC carries `authorization: Bearer <token>`. Before any other check
 * the router answers, and the call ends:
 * - no header, or a token the table does not know: `UNAUTHENTICATED`,
 *   reason `invalid_instance_token`;
 * - a token whose instance is `stopped`, `lost` or `invalid`:
 *   `UNAUTHENTICATED`, reason `instance_revoked`;
 * - a token whose instance is `spawned`, on any method but `Connect`:
 *   `FAILED_PRECONDITION`, reason `not_connected`;
 * - `Connect` with a token whose control stream is open:
 *   `FAILED_PRECONDITION`, reason `control_stream_open`.
 * A path that is neither `Connect` nor a method of the index answers
 * `UNIMPLEMENTED`, reason `unknown_contract`. Errors carry the reason as
 * `toConnectError` writes it (`contracts/status.ts`). What an authenticated
 * call to a method of the index gets is the relay's (section 3, steps 2–8).
 *
 * On an open control stream the first frame must be a `Hello` whose
 * `instance` equals the token's record and whose `protocolVersion` is 1;
 * then the router answers `Accepted { protocolVersion: 1 }`. Once the
 * instance is `active`, the router sends a `HealthCheck` at every health
 * interval until the stream ends, and declares it invalid with
 * `health_timeout` when a reply misses the health timeout, unless the timer
 * fired more than the stall threshold late: then it reports `hostStalled`
 * and checks again. The Hello timeout is not the router's: it counts from
 * the spawn.
 *
 * Registrations across a provider's instances (section 4), from the states
 * the instance table records, whoever set them:
 * - an instance becomes `stopped`, `lost` or `invalid`: the router sends
 *   `InstanceGone { instance }` on the accepted control stream of every
 *   `connected`, `active` and `draining` instance of every bundle that
 *   provides (`providersOf`) a contract the gone bundle's `host` part lists
 *   under `requires` or `optional`; once per instance;
 * - an instance becomes `active`: for each contract its bundle provides,
 *   the router sends `ProviderChanged { contractId, instance }` to every
 *   `active` or `draining` instance with an accepted control stream of every
 *   bundle `consumersOf` the contract answers, and holds the calls to the
 *   new instance (`CallRelay.holdForReplay`) until each of them answered
 *   `ReplayDone` with the same `contractId` and `instance`, or
 *   `timings.replayTimeoutMs` passed since the `ProviderChanged`. With no
 *   such consumer it sends nothing and holds nothing;
 * - at the replay timeout, each pending consumer is reported once with
 *   `registrationReplay('registration_replay_late', …)` and the held calls
 *   start; a pending consumer's call with `doric-target` naming the new
 *   instance (its replay) goes through the hold at once, and one that failed
 *   is reported with `registration_replay_failed`; a pending consumer whose
 *   control stream ends is no longer waited for, and is not reported;
 * - a `ReplayDone` that matches no pending `ProviderChanged` (late, or
 *   unknown) is ignored; it is never a protocol violation.
 */
export interface Router {
  /** The bound port, given to every bundle process in `DORIC_ROUTER_URL`. */
  readonly port: number;
  /**
   * Serves one call the gateway relays, in process: `CallRelay.serveGateway`
   * of the router's relay, so the call goes through steps 2 to 8 of section
   * 3 with the caller `doric` and is checked against the lists of
   * `clientPart`'s client part, or against none when `clientPart` is
   * undefined (D34). The only way a client part reaches the router: a
   * `doric-client-part` header that reaches the router listener is dropped.
   * Never rejects; after {@link Router.close} answers `UNAVAILABLE`, reason
   * `unavailable`.
   */
  serveGateway(
    request: UniversalServerRequest,
    clientPart: string | undefined,
  ): Promise<UniversalServerResponse>;
  /**
   * The `active` instance of `bundleId` with an accepted control stream
   * whose Hello reported a non-zero `httpPort`, and that port; `undefined`
   * when there is none (no active instance, or it declares no prefix).
   * Reads the current state; does not wait. Never throws.
   */
  httpTargetOf(bundleId: string): HttpTarget | undefined;
  /**
   * `CallRelay.trackConnection` of the router's relay: a connection the
   * gateway proxied to `key` counts as a call in flight to `key`, so
   * {@link Router.drain} waits for it, until the answered function is
   * called; the drain deadline, or {@link Router.close}, calls `cancel`
   * instead. Never throws.
   */
  trackConnection(key: InstanceKey, cancel: () => void): () => void;
  /**
   * Sends `Activate` to a `connected` instance and resolves with its
   * `ActivateResult`'s status; on code 0 the instance is `active` before the
   * promise resolves. With no result within the activation timeout it
   * resolves with code `DEADLINE_EXCEEDED`, and a result arriving later is
   * ignored. Rejects with a `ContractError` `not_connected` when the instance
   * has no accepted control stream, and `generation_lost` when the stream
   * ends before the result.
   */
  sendActivate(key: InstanceKey): Promise<Status>;
  /**
   * Sets the instance `stopping`, sends `Stop`, and resolves when its control
   * stream has ended or the stop timeout has passed, whichever comes first.
   * Never rejects; an instance with no open control stream resolves at once.
   * Setting `stopped` and killing the process are the supervisor's.
   */
  sendStop(key: InstanceKey): Promise<void>;
  /**
   * Sends `GenerationChanged { event, subject, live }` (section 6) on the
   * accepted control stream of every live instance of `subject`'s bundle:
   * `connected`, `active` or `draining`, the subject included when it is
   * live itself. `subject` is the instance the event is about; `live` lists
   * the bundle's `active` and `draining` instances as the table holds them
   * when the frames are sent, each with its state. Resolves once every
   * receiver answered `GenerationAck` with the same event, its stream
   * ended, or `generationAckTimeoutMs` (`control.ts`) passed, whichever
   * comes first for each; never rejects. An ack the router no longer waits
   * for is ignored, never a protocol violation. `draining` is sent by
   * {@link Router.drain} and `lost` by the router itself (see
   * {@link RouterOptions.onLost}); the supervisor sends `activated` after a
   * publish activated a new generation, and `stopped` after a drained
   * instance stopped.
   */
  announce(
    event: Exclude<GenerationEvent, 'draining'>,
    subject: InstanceKey,
  ): Promise<void>;
  /**
   * Drains an instance (section 6, "Drain"), in this order: sets it
   * `draining`, so it gets no new call without `doric-target`; ends every
   * resumable stream pinned to it (`CallRelay.endResumable`); sends it
   * `GenerationChanged { event: "draining" }` as {@link Router.announce}
   * does, to it alone, and waits for its ack — {@link Drain.acknowledged};
   * then waits until no call is in flight to or from it
   * (`CallRelay.inFlight`) and `held()` answers false, checked after the
   * ack and again after every call to or from it ends, platform calls
   * (`doric.generation/v1.Release`) included. When `timings.drainDeadlineMs`
   * passes from the call to `drain` first, cancels every call still in
   * flight to or from it (`CallRelay.cancelDrained`, reason `drained`) and
   * ignores its holds. {@link Drain.settled} says which came first, or
   * `lost` when the instance became `lost`, `invalid` or `stopped` before.
   * Sends no
   * `Stop`: that is the supervisor's. Never throws; draining a key with no
   * accepted control stream settles at once with `lost`.
   */
  drain(key: InstanceKey, held: () => boolean): Drain;
  /**
   * Delivers `PeerSignal { topic, payload, from }` (section 6, "Generation
   * events and peer signals") on the accepted control stream of every
   * other live instance (`connected`, `active` or `draining`) of `from`'s
   * bundle, and to no other bundle; `from` itself gets nothing. No answer
   * is awaited. Never throws. The `signal` of `createGenerationService`.
   */
  sendPeerSignal(
    from: InstanceRecord,
    topic: string,
    payload: Value | undefined,
  ): void;
  /**
   * Replaces the routes the router reads (see {@link RouterOptions.routes})
   * for every later call, `ProviderChanged` and `InstanceGone`: a publish
   * passes `callRoutesOf(next)`. A call already routed keeps its route.
   * Never throws.
   */
  setRoutes(routes: CallRoutes): void;
  /**
   * Stops listening, ends every control stream and call, and closes every
   * HTTP/2 session; resolves when the server is closed. Calls neither
   * `onInvalid` nor `onLost`. A second call resolves too.
   */
  close(): Promise<void>;
}

/**
 * Binds the router listener and resolves once it listens. Rejects with a
 * {@link RouterBindingError} when the address is malformed, not loopback, or
 * cannot be bound; nothing is left listening then.
 */
export const startRouter = async (options: RouterOptions): Promise<Router> => {
  const address = options.address ?? defaultRouterAddress;
  const bindTo = parseAddress(address);
  const streams = new Map<InstanceKey, ControlStream>();
  const timings = options.timings ?? platformTimings;
  let current = options.routes ?? noRoutes;
  // The replay coordinator reads the routes through this view, so a
  // publish's `setRoutes` reaches it.
  const routes: CallRoutes = {
    declarationsOf: (bundleId, part) => current.declarationsOf(bundleId, part),
    providersOf: (contractId) => current.providersOf(contractId),
    consumersOf: (contractId) => current.consumersOf(contractId),
  };
  const channel = (key: InstanceKey): ControlStream | undefined => {
    const stream = streams.get(key);

    return stream?.accepted === true ? stream : undefined;
  };
  const relay = createCallRelay({
    index: options.index,
    instances: options.instances,
    routes: current,
    platformServices: options.platformServices ?? [],
    timings,
    channel,
  });
  const env: StreamEnv = {
    instances: options.instances,
    timings,
    diagnostics: options.diagnostics,
    onInvalid: options.onInvalid,
    onLost: options.onLost,
    relay,
    replays: createReplayCoordinator({
      instances: options.instances,
      routes,
      relay,
      timings,
      diagnostics: options.diagnostics,
      channels: function* () {
        for (const [key, stream] of streams) {
          if (stream.accepted) {
            yield [key, stream];
          }
        }
      },
    }),
    streams,
    closing: false,
  };
  const connectRoutes = (router: ConnectRouter): void => {
    router.service(BundleHostService, {
      connect: (requests, context) => serveControl(env, requests, context),
    });
  };
  const fallback: NodeFallback = (request, response) => {
    const { authorization } = request.headers;
    let caller: InstanceRecord;

    try {
      caller = authenticate(
        env.instances,
        typeof authorization === 'string' ? authorization : undefined,
        false,
      );
    } catch (error) {
      void universalResponseToNodeResponse(
        trailersOnly(toStatus(toContractError(error))),
        response,
      ).catch(() => {});

      return;
    }

    env.relay
      .serve(
        caller,
        universalRequestFromNodeRequest(
          request,
          response,
          undefined,
          undefined,
        ),
      )
      .then((answer) => universalResponseToNodeResponse(answer, response))
      .catch(() => {
        // The caller is gone; the relay has ended the call.
      });
  };
  const bound = await listen(
    bindTo,
    address,
    connectNodeAdapter({
      grpc: true,
      connect: false,
      grpcWeb: false,
      readMaxBytes: maxMessageBytes,
      writeMaxBytes: maxMessageBytes,
      routes: connectRoutes,
      fallback,
    }),
  );
  let closed: Promise<void> | undefined;

  return {
    port: bound.port,
    serveGateway: (request, clientPart) =>
      env.relay.serveGateway(request, clientPart),
    httpTargetOf: (bundleId) => {
      const active = env.instances.activeOf(bundleId);
      const key = active === undefined ? undefined : instanceKey(active);
      const port = key === undefined ? 0 : (channel(key)?.httpPort ?? 0);

      return key === undefined || port === 0 ? undefined : { key, port };
    },
    trackConnection: (key, cancel) => env.relay.trackConnection(key, cancel),
    announce: (event, subject) => announce(env, event, subject),
    drain: (key, held) =>
      drainInstance(
        {
          instances: env.instances,
          relay: env.relay,
          timings: env.timings,
          accepted: (drained) => channel(drained) !== undefined,
          announceDraining: (drained) =>
            announce(env, 'draining', drained, drained),
        },
        key,
        held,
      ),
    sendPeerSignal: (from, topic, payload) =>
      signalPeers(env, from, topic, payload),
    setRoutes: (next) => {
      current = next;
      env.relay.setRoutes(next);
    },
    sendActivate: (key) => {
      const stream = env.streams.get(key);

      if (stream === undefined || !stream.accepted) {
        return Promise.reject(
          new ContractError(
            'not_connected',
            `The instance ${key} has no accepted control stream.`,
          ),
        );
      }

      return stream.activate();
    },
    sendStop: async (key) => {
      env.instances.setState(key, 'stopping');

      const stream = env.streams.get(key);

      if (stream === undefined) {
        return;
      }

      stream.send({ frame: { case: 'stop', value: {} } });

      let timer: NodeJS.Timeout | undefined;

      await Promise.race([
        stream.ended,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, env.timings.stopTimeoutMs);
        }),
      ]);
      clearTimeout(timer);
    },
    close: () => {
      closed ??= (() => {
        env.closing = true;
        env.replays.close();
        env.relay.close();

        for (const stream of env.streams.values()) {
          stream.terminate();
        }

        return bound.close();
      })();

      return closed;
    },
  };
};

/** The routes of a router given none: nobody declares or provides anything. */
const noRoutes: CallRoutes = {
  declarationsOf: () => undefined,
  providersOf: () => [],
  consumersOf: () => [],
};

/** The Node handler of a path no Connect route serves. */
type NodeFallback = NonNullable<ConnectNodeAdapterOptions['fallback']>;
