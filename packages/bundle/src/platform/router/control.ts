// The router's side of the control stream (spec
// `docs/designs/grpc-processes.md`, section 5): the values of protocol
// version 1 and the outcomes the router reports to the supervisor. The
// stream itself is served by `ControlStream` (`stream.ts`).

import type { RegistrationReplayReport } from '../../runtime/diagnostics.js';
import type { InstanceKey } from './instances.js';

/**
 * The largest frame, and the largest message of a relayed call, in either
 * direction: 4 MiB (U20). Declared in `contracts/metadata.ts`, browser-safe,
 * and re-exported here for the router's importers.
 */
export { maxMessageBytes } from '../../contracts/metadata.js';

/** The only `protocolVersion` this router speaks; `Accepted` carries it. */
export const protocolVersion = 1;

/**
 * The `initialCredit` of every `CallStart`, and the request messages the
 * router sends before a `CallCredit`: 16 messages per call in each
 * direction (section 5, "Flow control"). A constant of protocol version 1.
 */
export const initialCallCredit = 16;

/**
 * The `event` of a `GenerationChanged` frame (section 6): `draining` to the
 * instance that starts to drain, `activated` to every live instance of a
 * bundle whose new generation became `active` by a publish (the boot's
 * activation is not announced), `lost` and `stopped` to the other live
 * instances of a bundle one of whose instances was lost or stopped.
 */
export type GenerationEvent = 'draining' | 'activated' | 'lost' | 'stopped';

/**
 * How long the SDK waits for a bundle's generation handlers before it
 * answers a `GenerationChanged` with its `GenerationAck` anyway, and the
 * longest the router waits for that ack before it goes on: 10 s (section 6,
 * "Publish", step 3). A constant of protocol version 1.
 */
export const generationAckTimeoutMs = 10_000;

/**
 * The `reason` of a `Rejected` frame. `hello_mismatch`: the Hello's
 * `instance` differs from the token's record; `unsupported_protocol`: its
 * `protocolVersion` is not {@link protocolVersion}; `protocol_violation`: a
 * frame before `Hello`, a second `Hello`, a `CallEnd` or `CallMessage` for an
 * unknown `call_id`, a `CallMessage` beyond credit, an unknown `oneof` case,
 * or a frame over {@link maxMessageBytes}.
 */
export type RejectReason =
  | 'hello_mismatch'
  | 'unsupported_protocol'
  | 'protocol_violation';

/**
 * Why the router declared an instance invalid, as the quarantine code the
 * supervisor records (section 7, "Invalid bundles"): `invalid_bundle` for a
 * rejected Hello or a protocol violation, `health_timeout` for a missed
 * health answer.
 */
export type InvalidReason = 'invalid_bundle' | 'health_timeout';

/**
 * How the control stream of an instance that was `connected`, `active` or
 * `draining` ended without `Stop`: closed by the bundle (`closed`), or reset
 * or failed at the transport (`reset`). `message` is for the diagnostics.
 * The process's exit code or signal is the supervisor's to add.
 */
export interface StreamEnd {
  readonly cause: 'closed' | 'reset';
  readonly message: string;
}

/** What the router records in the diagnostics (section 15). */
export interface RouterDiagnostics {
  /** A `HealthReply` arrived, `latencyMs` after its `HealthCheck`. */
  health(key: InstanceKey, latencyMs: number): void;
  /**
   * A health timeout fired `delayMs` after its due time, more than the stall
   * threshold: the host's loop was blocked, and no instance was declared
   * invalid for it (`host_stalled`, RK17).
   */
  hostStalled(key: InstanceKey, delayMs: number): void;
  /**
   * A consumer's replay to a new provider instance failed
   * (`registration_replay_failed`: a replay call of `consumer` to `provider`
   * ended with a status other than `OK`, `message` naming the method and
   * the status), or `consumer` did not answer `ReplayDone` within the replay
   * timeout (`registration_replay_late`), after which the router released
   * the calls it held (section 4). Never awaited; a throw is ignored.
   */
  registrationReplay(
    kind: RegistrationReplayReport['kind'],
    consumer: InstanceKey,
    provider: InstanceKey,
    message: string,
  ): void;
}
