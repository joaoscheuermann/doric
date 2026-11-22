// One instance's control stream on the router (spec
// `docs/designs/grpc-processes.md`, section 5, "The control stream"): its
// Hello, the frames it reads and sends, its activation, health and end.

import { create, type MessageInitShape } from '@bufbuild/protobuf';
import type { Value } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError } from '@connectrpc/connect';

import { ContractError } from '../../contracts/error.js';
import {
  type ActivateResult,
  type ConnectRequest,
  type ConnectResponse,
  ConnectResponseSchema,
  type GenerationChangedSchema,
  type Hello,
} from '../../contracts/gen/doric/platform/v1/control_pb.js';
import {
  type Status,
  StatusSchema,
} from '../../contracts/gen/google/rpc/status_pb.js';
import type { Timings } from '../supervisor/timings.js';
import type { CallRelay, ControlChannel } from './calls.js';
import {
  type GenerationEvent,
  generationAckTimeoutMs,
  type InvalidReason,
  maxMessageBytes,
  protocolVersion,
  type RejectReason,
  type RouterDiagnostics,
  type StreamEnd,
} from './control.js';
import { HealthChecks } from './health.js';
import {
  type InstanceKey,
  type InstanceRecord,
  type InstanceTable,
  instanceKey,
  instanceOf,
} from './instances.js';
import type { RouterOptions } from './listener.js';
import type { ReplayCoordinator } from './replay.js';

/** What the control streams of one router share. */
export interface StreamEnv {
  readonly instances: InstanceTable;
  readonly timings: Timings;
  readonly diagnostics: RouterDiagnostics;
  readonly onInvalid: RouterOptions['onInvalid'];
  readonly onLost: RouterOptions['onLost'];
  /** The calls relayed over the control streams. */
  readonly relay: CallRelay;
  /** `InstanceGone`, `ProviderChanged` and the replay holds (section 4). */
  readonly replays: ReplayCoordinator;
  /** The open control streams, by instance. */
  readonly streams: Map<InstanceKey, ControlStream>;
  /** Set by `close()`: streams then end without `onInvalid` or `onLost`. */
  closing: boolean;
}

/** States whose stream ending without `Stop` makes the instance `lost`. */
export const liveStates: ReadonlySet<InstanceRecord['state']> = new Set([
  'connected',
  'active',
  'draining',
]);

/** The accepted control streams of the live instances of `bundleId`. */
export const liveStreamsOf = (
  env: Pick<StreamEnv, 'instances' | 'streams'>,
  bundleId: string,
): ControlStream[] =>
  [...env.streams.values()].filter((stream) => {
    const state = env.instances.get(stream.key)?.state;

    return (
      stream.accepted &&
      stream.bundleId === bundleId &&
      state !== undefined &&
      liveStates.has(state)
    );
  });

/**
 * Sends `GenerationChanged` about `subject` as `Router.announce` says, to
 * the live instances of its bundle, or to `only` alone; resolves when each
 * receiver acknowledged it, its stream ended or the ack timeout passed.
 */
export const announce = (
  env: Pick<StreamEnv, 'instances' | 'streams'>,
  event: GenerationEvent,
  subject: InstanceKey,
  only?: InstanceKey,
): Promise<void> => {
  const record = env.instances.get(subject);

  if (record === undefined) {
    return Promise.resolve();
  }

  const receivers = liveStreamsOf(env, record.bundleId);
  const live = receivers.flatMap((stream) => {
    const state = env.instances.get(stream.key)?.state;

    return state === 'active' || state === 'draining'
      ? [{ instance: instanceOf(stream.record), state }]
      : [];
  });
  const frame: MessageInitShape<typeof GenerationChangedSchema> = {
    event,
    subject: instanceOf(record),
    live,
  };

  return Promise.all(
    receivers
      .filter((stream) => only === undefined || stream.key === only)
      .map((stream) => stream.generationChanged(frame)),
  ).then(() => undefined);
};

/** Sends `PeerSignal` from `from` to the other live instances of its bundle. */
export const signalPeers = (
  env: Pick<StreamEnv, 'instances' | 'streams'>,
  from: InstanceRecord,
  topic: string,
  payload: Value | undefined,
): void => {
  for (const receiver of liveStreamsOf(env, from.bundleId)) {
    if (receiver.key !== instanceKey(from)) {
      receiver.send({
        frame: {
          case: 'peerSignal',
          value: {
            topic,
            ...(payload === undefined ? {} : { payload }),
            from: instanceOf(from),
          },
        },
      });
    }
  }
};

interface PendingActivation {
  readonly resolve: (status: Status) => void;
  readonly reject: (error: ContractError) => void;
  readonly timer: NodeJS.Timeout;
}

/** A `GenerationChanged` waiting for its `GenerationAck`. */
interface PendingAck {
  readonly event: string;
  readonly done: () => void;
}

/** One open control stream: its frames, activation, health and end. */
export class ControlStream implements ControlChannel {
  /** Whether the router answered the Hello with `Accepted`. */
  accepted = false;
  /** The services its accepted Hello listed. */
  services: ReadonlySet<string> = new Set();
  /** The `httpPort` its accepted Hello reported; 0 for none. */
  httpPort = 0;
  /** Resolves when the stream has ended, for any reason. */
  readonly ended: Promise<void>;

  private finished = false;
  private markEnded!: () => void;
  private readonly outgoing: ConnectResponse[] = [];
  private wake: (() => void) | undefined;
  private readonly activations: PendingActivation[] = [];
  private readonly acks: PendingAck[] = [];
  private readonly health: HealthChecks;

  constructor(
    private readonly env: StreamEnv,
    readonly key: InstanceKey,
    readonly record: InstanceRecord,
  ) {
    this.ended = new Promise((resolve) => {
      this.markEnded = resolve;
    });
    this.health = new HealthChecks(
      key,
      env.timings,
      env.diagnostics,
      (nonce) =>
        this.send({ frame: { case: 'healthCheck', value: { nonce } } }),
      (message) => this.invalidate('health_timeout', message),
    );
  }

  send(frame: MessageInitShape<typeof ConnectResponseSchema>): void {
    if (this.finished) {
      return;
    }

    this.outgoing.push(create(ConnectResponseSchema, frame));
    this.wake?.();
  }

  /** The frames to send, until the stream finishes. */
  async *responses(): AsyncGenerator<ConnectResponse> {
    for (;;) {
      const next = this.outgoing.shift();

      if (next !== undefined) {
        yield next;
        continue;
      }

      if (this.finished) {
        return;
      }

      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = undefined;
    }
  }

  /** Reads the bundle's frames until its request stream ends. */
  async read(requests: AsyncIterable<ConnectRequest>): Promise<void> {
    try {
      for await (const request of requests) {
        if (this.finished) {
          return;
        }

        this.receive(request);
      }

      this.end('closed', 'The bundle closed its control stream.');
    } catch (error) {
      if (
        error instanceof ConnectError &&
        error.code === Code.ResourceExhausted
      ) {
        this.reject(
          'protocol_violation',
          `A frame exceeds ${maxMessageBytes} bytes.`,
        );

        return;
      }

      this.end(
        'reset',
        error instanceof Error ? error.message : 'The stream failed.',
      );
    }
  }

  /** The bundle of the stream's instance. */
  get bundleId(): string {
    return this.record.bundleId;
  }

  /**
   * Sends `GenerationChanged`; resolves on the first `GenerationAck` of the
   * same event, the stream's end, or `generationAckTimeoutMs`.
   */
  generationChanged(
    frame: MessageInitShape<typeof GenerationChangedSchema>,
  ): Promise<void> {
    if (this.finished) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      const pending: PendingAck = {
        event: frame.event ?? '',
        done: () => {
          clearTimeout(timer);

          const index = this.acks.indexOf(pending);

          if (index >= 0) {
            this.acks.splice(index, 1);
          }

          resolve();
        },
      };
      const timer = setTimeout(pending.done, generationAckTimeoutMs);

      this.acks.push(pending);
      this.send({ frame: { case: 'generationChanged', value: frame } });
    });
  }

  /** Sends `Activate`; resolves with the `ActivateResult`'s status. */
  activate(): Promise<Status> {
    return new Promise<Status>((resolve, reject) => {
      const pending: PendingActivation = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.activations.splice(this.activations.indexOf(pending), 1);
          resolve(
            create(StatusSchema, {
              code: Code.DeadlineExceeded,
              message: `No ActivateResult within ${this.env.timings.activationTimeoutMs} ms.`,
            }),
          );
        }, this.env.timings.activationTimeoutMs),
      };

      this.activations.push(pending);
      this.send({ frame: { case: 'activate', value: {} } });
    });
  }

  /**
   * The request stream ended (or the transport failed): sets `lost` and calls
   * `onLost` for a live instance, unless the router is closing. Idempotent.
   */
  end(cause: StreamEnd['cause'], message: string): void {
    if (this.finished) {
      return;
    }

    const state = this.env.instances.get(this.key)?.state;

    this.terminate();

    if (!this.env.closing && state !== undefined && liveStates.has(state)) {
      this.env.instances.setState(this.key, 'lost');
      void announce(this.env, 'lost', this.key);
      this.env.onLost(this.key, { cause, message });
    }
  }

  /** Finishes the stream with no callback: timers stop, waiters settle. */
  terminate(): void {
    if (this.finished) {
      return;
    }

    this.finished = true;
    this.wake?.();
    this.health.stop();

    for (const pending of [...this.acks]) {
      pending.done();
    }

    for (const pending of this.activations.splice(0)) {
      clearTimeout(pending.timer);
      pending.reject(
        new ContractError(
          'generation_lost',
          `The control stream of ${this.key} ended before its ActivateResult.`,
        ),
      );
    }

    if (this.env.streams.get(this.key) === this) {
      this.env.streams.delete(this.key);
    }

    this.env.relay.channelEnded(this.key);
    this.env.replays.channelEnded(this.key);
    this.markEnded();
  }

  private receive(request: ConnectRequest): void {
    const { frame } = request;

    if (!this.accepted) {
      if (frame.case === 'hello') {
        this.hello(frame.value);
      } else {
        this.reject('protocol_violation', 'The first frame is not a Hello.');
      }

      return;
    }

    switch (frame.case) {
      case 'hello':
        this.reject('protocol_violation', 'A second Hello.');
        return;
      case 'activateResult':
        this.activateResult(frame.value);
        return;
      case 'healthReply':
        this.health.reply(frame.value.nonce);
        return;
      case 'callEnd':
      case 'callMessage':
      case 'callCredit':
        if (!this.env.relay.receive(this.key, frame)) {
          this.reject(
            'protocol_violation',
            `A ${frame.case} for the unknown call ${frame.value.callId}, or beyond its credit.`,
          );
        }

        return;
      case 'replayDone':
        this.env.replays.replayDone(this.key, frame.value);
        return;
      case 'generationAck':
        this.acks.find(({ event }) => event === frame.value.event)?.done();
        return;
      case undefined:
        this.reject('protocol_violation', 'A frame of an unknown case.');
        return;
      default:
        return;
    }
  }

  private hello(hello: Hello): void {
    if (hello.protocolVersion !== protocolVersion) {
      this.reject(
        'unsupported_protocol',
        `The router speaks protocol version ${protocolVersion}, not ${hello.protocolVersion}.`,
      );

      return;
    }

    const { instance } = hello;

    if (
      instance === undefined ||
      instance.bundleId !== this.record.bundleId ||
      instance.generation !== this.record.generation ||
      instance.incarnation !== this.record.incarnation
    ) {
      this.reject(
        'hello_mismatch',
        `The Hello's instance differs from ${this.key}.`,
      );

      return;
    }

    this.accepted = true;
    this.services = new Set(hello.services);
    this.httpPort = hello.httpPort;
    this.env.instances.setState(this.key, 'connected');
    this.send({ frame: { case: 'accepted', value: { protocolVersion } } });
  }

  private activateResult(result: ActivateResult): void {
    const pending = this.activations.shift();

    if (pending === undefined) {
      return;
    }

    clearTimeout(pending.timer);

    const status = result.status ?? create(StatusSchema);

    if (status.code === 0) {
      this.env.instances.setState(this.key, 'active');
      this.health.start();
    }

    pending.resolve(status);
  }

  /** Sends `Rejected` and declares the instance invalid. */
  private reject(reason: RejectReason, message: string): void {
    if (this.finished) {
      return;
    }

    this.send({ frame: { case: 'rejected', value: { reason, message } } });
    this.invalidate('invalid_bundle', `${reason}: ${message}`);
  }

  private invalidate(reason: InvalidReason, message: string): void {
    if (this.finished) {
      return;
    }

    this.env.instances.setState(this.key, 'invalid');
    this.terminate();

    if (!this.env.closing) {
      this.env.onInvalid(this.key, reason, message);
    }
  }
}
