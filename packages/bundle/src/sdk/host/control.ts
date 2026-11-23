// The bundle's side of the control stream (spec
// `docs/designs/grpc-processes.md`, section 5, and section 7, "A bundle
// without its host"): the exit codes and the ways the SDK finds its host
// gone. The router's side is `platform/router/control.ts`.

/**
 * The exit code of a bundle process whose host is gone (section 7, "A
 * bundle without its host"): its Hello was rejected, its control stream
 * ended after `Accepted`, or no `Accepted` arrived within the Hello timeout.
 * The Rust SDK exits with the same code.
 */
export const EXIT_HOST_GONE = 70;

/** The exit code of a bundle process after it answered `Stop` with `StopResult`. */
export const EXIT_STOPPED = 0;

/**
 * Why the SDK found its host gone, as {@link HostGoneError.reason}:
 *
 * - `environment`: a spawn variable is missing or malformed, so there is no
 *   host to connect to (the message names the variable);
 * - `rejected`: the router answered the Hello with `Rejected` (the message
 *   carries its `reason` and `message`);
 * - `closed`: the control stream ended, closed or failed at the transport,
 *   before `Accepted` without a `Rejected`, or at any time after `Accepted`
 *   without a `Stop`;
 * - `hello_timeout`: no `Accepted` arrived within the Hello timeout of the
 *   start, whether the stream could not be opened or was never answered.
 */
export type HostGoneReason =
  | 'environment'
  | 'rejected'
  | 'closed'
  | 'hello_timeout';

/**
 * The host of a bundle process is gone. `startBundle` rejects with it when
 * the host is gone before `Accepted`; by then the SDK has called the `exit`
 * it was given with {@link EXIT_HOST_GONE}. After `Accepted` the SDK only
 * exits: no promise of the caller rejects with it.
 */
export class HostGoneError extends Error {
  override readonly name = 'HostGoneError';
  readonly reason: HostGoneReason;

  constructor(reason: HostGoneReason, message: string, options?: ErrorOptions) {
    super(message, options);
    this.reason = reason;
  }
}
