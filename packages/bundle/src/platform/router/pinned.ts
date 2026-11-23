// One call relayed over an instance's control stream (spec
// `docs/designs/grpc-processes.md`, section 3, steps 5 to 8): its `CallStart`,
// request messages and credit, the response messages it relays unchanged
// (D2), and its end.

import { create } from '@bufbuild/protobuf';
import { Code } from '@connectrpc/connect';
import {
  type EnvelopedMessage,
  encodeEnvelope,
  pipe,
  transformSplitEnvelope,
  type UniversalServerRequest,
} from '@connectrpc/connect/protocol';

import type { CallScope } from '../../contracts/call.js';
import { ContractError } from '../../contracts/error.js';
import {
  type Status,
  StatusSchema,
} from '../../contracts/gen/google/rpc/status_pb.js';
import { toStatus } from '../../contracts/status.js';
import type { ControlChannel } from './calls.js';
import { initialCallCredit, maxMessageBytes } from './control.js';
import { cutOff, drained, type Flights } from './flights.js';
import type { InstanceRecord } from './instances.js';
import type { Reach, Replay } from './reach.js';
import type { CallRoute } from './route.js';
import { onlyMessage, requestError, traceOf, writeStatus } from './wire.js';

/** The calls pinned to one instance's control stream. */
export interface Pins {
  nextId: bigint;
  readonly open: Map<bigint, PinnedCall>;
}

/** One relayed call: what the instance sent, until its status. */
export class PinnedCall {
  /** The response messages the instance may still send. */
  credit = initialCallCredit;
  /** The request messages the router may still send the instance. */
  private requestCredit = initialCallCredit;
  private ended = false;

  private readonly items: (Uint8Array | Status)[] = [];
  private wake: (() => void) | undefined;
  private wakeSender: (() => void) | undefined;

  constructor(readonly id: bigint) {}

  push(item: Uint8Array | Status): void {
    if (!(item instanceof Uint8Array)) {
      this.ended = true;
      this.wakeSender?.();
    }

    this.items.push(item);
    this.wake?.();
  }

  /** The instance's `CallCredit`: `messages` more request messages. */
  grant(messages: number): void {
    this.requestCredit += messages;
    this.wakeSender?.();
  }

  /**
   * Takes one request message of credit, waiting for a `CallCredit`;
   * `false` once the call has ended.
   */
  async spend(): Promise<boolean> {
    while (this.requestCredit === 0 && !this.ended) {
      await new Promise<void>((resolve) => {
        this.wakeSender = resolve;
      });
      this.wakeSender = undefined;
    }

    if (this.ended) {
      return false;
    }

    this.requestCredit -= 1;

    return true;
  }

  async next(): Promise<Uint8Array | Status> {
    for (;;) {
      const item = this.items.shift();

      if (item !== undefined) {
        return item;
      }

      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = undefined;
    }
  }
}

/**
 * Sends the request messages of a client or bidirectional stream as
 * `CallMessage`, then `CallHalfClose`, while the call is open.
 */
export const forward = async (
  requests: AsyncIterable<EnvelopedMessage>,
  call: PinnedCall,
  open: () => boolean,
  channel: ControlChannel,
  onFailure: (error: unknown) => void,
): Promise<void> => {
  try {
    for await (const { data } of requests) {
      if (!open() || !(await call.spend())) {
        return;
      }

      channel.send({
        frame: {
          case: 'callMessage',
          value: { callId: call.id, payload: data },
        },
      });
    }

    if (open()) {
      channel.send({
        frame: { case: 'callHalfClose', value: { callId: call.id } },
      });
    }
  } catch (error) {
    onFailure(error);
  }
};

/** The response body of a relayed call; sets `trailer` when it ends. */
export async function* relayCall(
  env: { readonly flights: Flights; readonly reach: Reach['reach'] },
  caller: InstanceRecord,
  request: UniversalServerRequest & { body: AsyncIterable<Uint8Array> },
  route: Exclude<CallRoute, { kind: 'platform' }>,
  scope: CallScope | undefined,
  deadline: number,
  trailer: Headers,
): AsyncGenerator<Uint8Array> {
  const { method } = route;
  const streamsRequest =
    method.kind === 'client_stream' || method.kind === 'bidi';
  const streamsResponse =
    method.kind === 'server_stream' || method.kind === 'bidi';
  const requests = pipe(request.body, transformSplitEnvelope(maxMessageBytes));
  let status: Status | undefined;
  let replay: Replay | undefined;
  const flight = env.flights.track(caller, method.resumable);

  try {
    const payload = streamsRequest ? undefined : await onlyMessage(requests);
    const reaching = env.reach(caller, request, route, deadline);

    reaching.catch(() => {});

    const reached = await Promise.race([
      reaching,
      cutOff(flight).then(() => ({ status: drained(flight.from) })),
    ]);

    if (!('key' in reached)) {
      status = reached.status;

      return;
    }

    const { key, channel } = reached;

    replay = reached.replay;

    if (!channel.services.has(method.service.typeName)) {
      throw new ContractError(
        'unknown_contract',
        `The instance ${key} does not serve ${method.service.typeName}.`,
      );
    }

    const call = env.flights.pin(key);

    flight.pinned = { key, call };

    const timer =
      deadline > 0
        ? setTimeout(
            () =>
              env.flights.cancel(
                key,
                call,
                'deadline',
                create(StatusSchema, {
                  code: Code.DeadlineExceeded,
                  message: `The call passed its deadline.`,
                }),
              ),
            Math.max(0, deadline - Date.now()),
          )
        : undefined;
    const onCancel = (): void =>
      env.flights.cancel(
        key,
        call,
        'cancelled',
        create(StatusSchema, {
          code: Code.Canceled,
          message: 'The caller cancelled the call.',
        }),
      );

    request.signal.addEventListener('abort', onCancel);
    channel.send({
      frame: {
        case: 'callStart',
        value: {
          callId: call.id,
          method: method.path,
          kind: method.kind,
          caller: {
            bundleId: caller.bundleId,
            version: caller.version,
            generation: caller.generation,
            incarnation: caller.incarnation,
          },
          scope: { ...scope },
          traceparent: traceOf(request.header).traceparent,
          deadlineUnixMs: deadline,
          initialCredit: initialCallCredit,
          ...(payload === undefined ? {} : { payload }),
        },
      },
    });

    if (streamsRequest) {
      void forward(
        requests,
        call,
        () => env.flights.isOpen(key, call),
        channel,
        (error) =>
          request.signal.aborted
            ? onCancel()
            : env.flights.cancel(
                key,
                call,
                'cancelled',
                toStatus(requestError(error)),
              ),
      );
    }

    try {
      for (;;) {
        const item = await call.next();

        if (!(item instanceof Uint8Array)) {
          status = item;

          return;
        }

        yield encodeEnvelope(0, item);

        if (streamsResponse) {
          call.credit += 1;
          channel.send({
            frame: {
              case: 'callCredit',
              value: { callId: call.id, messages: 1 },
            },
          });
        }
      }
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener('abort', onCancel);
    }
  } catch (error) {
    status = toStatus(requestError(error));
  } finally {
    if (flight.pinned !== undefined) {
      env.flights.cancel(
        flight.pinned.key,
        flight.pinned.call,
        'cancelled',
        create(StatusSchema, { code: Code.Canceled }),
      );
    }

    const final = status ?? create(StatusSchema, { code: Code.Canceled });

    if (replay !== undefined && final.code !== 0) {
      replay.failed(
        create(StatusSchema, {
          code: final.code,
          message: `${method.path} ended with code ${final.code}: ${final.message}`,
          details: final.details,
        }),
      );
    }

    writeStatus(trailer, final);
    env.flights.land(flight);
  }
}
