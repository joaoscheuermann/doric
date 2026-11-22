// The contracts a client part calls (spec `docs/designs/grpc-processes.md`,
// section 10, `bundle/client`, and section 4, "Resumable streams"): typed
// Connect clients over the part's own transport, which open a resumable
// server stream again when its provider instance was lost or began to drain.
// Browser-safe.

import type { DescService } from '@bufbuild/protobuf';
import { type Client, createClient, type Transport } from '@connectrpc/connect';

import {
  type ResumeRequests,
  withResumableStreams,
} from '../../runtime/resumable.js';
import {
  type ClientPartTransportOptions,
  createClientPartTransport,
} from './transport.js';

/** How {@link ClientPart.use} builds its client. */
export interface ClientUseOptions<S extends DescService> {
  /**
   * The requests that reopen resumable streams after an item was received;
   * a method without one reopens with its original request.
   */
  readonly resume?: ResumeRequests<S>;
}

/** The calls of one client part. */
export interface ClientPart {
  /** The bundle id the part's calls carry in `doric-client-part`. */
  readonly bundleId: string;
  /** The part's transport (`createClientPartTransport`), one per part. */
  readonly transport: Transport;
  /**
   * A Connect client of `ref` over the part's transport. Creating it makes
   * no call and never throws. Unary, client-streaming and bidirectional
   * methods, and server-streaming methods that are not resumable, behave as
   * `createClient(ref, transport)`'s.
   *
   * A server-streaming method whose descriptor has
   * `(doric.platform.v1.method).resumable = true` returns a stream that
   * `reopenResumable` (`runtime/resumable.ts`) iterates: when an opening
   * ends with `generation_lost`, the client opens it again after the delays
   * of `resumableDelays`, with `options.resume`'s request for the method
   * built from the last item received, or the original request when there
   * is none or no item arrived; the caller's next item is the new opening's
   * first, its snapshot. Every opening carries the call options of the
   * call; their `signal` aborting ends the iteration and cancels a pending
   * reopening. Any other error ends the iteration with that error, a
   * `ConnectError` whose Doric code `fromConnectError` reads. The same
   * reopening as the host SDK's `services.use`.
   */
  use<S extends DescService>(ref: S, options?: ClientUseOptions<S>): Client<S>;
}

/**
 * The calls of the client part `options.bundleId`: one transport
 * (`createClientPartTransport(options)`) shared by every client its `use`
 * answers. Creating it makes no call. Throws the `TypeError` of
 * `createClientPartTransport` for options it refuses.
 */
export const createClientPart = (
  options: ClientPartTransportOptions,
): ClientPart => {
  const transport = createClientPartTransport(options);

  return {
    bundleId: options.bundleId,
    transport,
    use: (ref, useOptions) =>
      withResumableStreams(
        ref,
        createClient(ref, transport),
        useOptions?.resume,
      ),
  };
};
