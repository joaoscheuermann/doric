// The instance a relayed call reaches (spec `docs/designs/grpc-processes.md`,
// section 3, step 4, and section 4, "When a provider changes"): the target
// instance, or the provider's active one once it has an accepted control
// stream, once no replay holds its calls.

import { create } from '@bufbuild/protobuf';
import { Code } from '@connectrpc/connect';
import type { UniversalServerRequest } from '@connectrpc/connect/protocol';

import { ContractError, toContractError } from '../../contracts/error.js';
import {
  type Status,
  StatusSchema,
} from '../../contracts/gen/google/rpc/status_pb.js';
import { targetHeader } from '../../contracts/metadata.js';
import { toStatus } from '../../contracts/status.js';
import type { CallRelay, CallRelayOptions, ControlChannel } from './calls.js';
import {
  type InstanceKey,
  type InstanceRecord,
  instanceKey,
} from './instances.js';
import {
  createReplayHold,
  type ReplayHold,
  type ReplayParty,
} from './replay.js';
import type { CallRoute } from './route.js';

/** An instance a call reaches, with its accepted control stream. */
export interface Reached {
  readonly key: InstanceKey;
  readonly channel: ControlChannel;
  /** Set when the call is a pending party's replay. */
  readonly replay?: Replay;
}

/** The calls' way to their instances, and the replay holds on the way. */
export interface Reach extends Pick<CallRelay, 'holdForReplay'> {
  /**
   * The instance `route` reaches once no replay holds the call: a call whose
   * caller is the consumer of a pending party and whose `doric-target` names
   * the held provider goes through at once, as a replay when it is on the
   * party's contract; any other (no `doric-target`, or one naming another
   * instance) waits for the release and reaches again. Answers the status that ends a call still
   * waiting at its deadline, cancelled by its caller, or at the close; rejects
   * with the `ContractError` of an instance it cannot reach.
   */
  reach(
    caller: InstanceRecord,
    request: UniversalServerRequest,
    route: Exclude<CallRoute, { kind: 'platform' }>,
    deadline: number,
  ): Promise<Reached | { status: Status }>;
}

/** No hold; `closing` aborts every wait. */
export const createReach = (
  options: Pick<CallRelayOptions, 'instances' | 'timings' | 'channel'>,
  closing: AbortSignal,
): Reach => {
  /** The instance a route reaches, once it has an accepted control stream. */
  const reachInstance = (
    route: Exclude<CallRoute, { kind: 'platform' }>,
    deadline: number,
  ): Promise<Reached> => {
    if (route.kind === 'target') {
      const state = options.instances.get(route.target)?.state;
      const channel = options.channel(route.target);

      if (state === undefined || !targetStates.has(state) || !channel) {
        return Promise.reject(
          new ContractError(
            'generation_lost',
            `The instance ${route.target} is not live.`,
          ),
        );
      }

      return Promise.resolve({ key: route.target, channel });
    }

    const pick = ():
      | { key: InstanceKey; channel: ControlChannel }
      | undefined => {
      const active = options.instances.activeOf(route.bundleId);
      const key = active === undefined ? undefined : instanceKey(active);
      const channel = key === undefined ? undefined : options.channel(key);

      return key === undefined || channel === undefined
        ? undefined
        : { key, channel };
    };

    return new Promise((resolve, reject) => {
      const picked = pick();

      if (picked !== undefined) {
        resolve(picked);

        return;
      }

      const waitMs =
        deadline > 0
          ? Math.max(0, deadline - Date.now())
          : options.timings.activeWaitMs;
      const settle = (done: () => void): void => {
        unsubscribe();
        clearTimeout(timer);
        closing.removeEventListener('abort', onClose);
        done();
      };
      const onClose = (): void => settle(() => reject(closing.reason));
      const unsubscribe = options.instances.subscribe(() => {
        const next = pick();

        if (next !== undefined) {
          settle(() => resolve(next));
        }
      });
      const timer = setTimeout(
        () =>
          settle(() =>
            reject(
              new ContractError(
                'unavailable',
                `${route.bundleId} has no active instance after ${waitMs} ms.`,
              ),
            ),
          ),
        waitMs,
      );

      closing.addEventListener('abort', onClose);
    });
  };

  /** The replay holds, by the provider instance whose calls they hold. */
  const holds = new Map<
    InstanceKey,
    {
      readonly hold: ReplayHold;
      readonly onReplayFailed: (party: ReplayParty, status: Status) => void;
    }
  >();

  const reach: Reach['reach'] = async (caller, request, route, deadline) => {
    const consumer = instanceKey(caller);

    for (;;) {
      const reached = await reachInstance(route, deadline);
      const held = holds.get(reached.key);

      if (held === undefined) {
        return reached;
      }

      const { pending } = held.hold;

      if (
        request.header.get(targetHeader) === reached.key &&
        pending.some((party) => party.consumer === consumer)
      ) {
        const party = pending.find(
          (each) =>
            each.consumer === consumer &&
            each.contractId === route.method.contract.id,
        );

        return party === undefined
          ? reached
          : {
              ...reached,
              replay: {
                failed: (status) => held.onReplayFailed(party, status),
              },
            };
      }

      const ended = await untilReleased(
        held.hold,
        deadline,
        request.signal,
        closing,
      );

      if (ended !== undefined) {
        return { status: ended };
      }
    }
  };

  return {
    reach,
    holdForReplay: (provider, parties, onReplayFailed) => {
      holds.get(provider)?.hold.release();

      const hold = createReplayHold(provider, parties);

      if (hold.pending.length > 0) {
        const entry = { hold, onReplayFailed };

        holds.set(provider, entry);
        void hold.released.then(() => {
          if (holds.get(provider) === entry) {
            holds.delete(provider);
          }
        });
      }

      return hold;
    },
  };
};

/** A call that is a pending party's replay: reports its failure. */
export interface Replay {
  readonly failed: (status: Status) => void;
}

/**
 * Waits until `hold` is released; answers `undefined` then, or the status
 * that ends the waiting call first: `DEADLINE_EXCEEDED` at `deadline` (0:
 * none), `CANCELLED` when `cancelled` aborts, the close's when `closing`
 * aborts.
 */
const untilReleased = (
  hold: ReplayHold,
  deadline: number,
  cancelled: AbortSignal,
  closing: AbortSignal,
): Promise<Status | undefined> =>
  new Promise((resolve) => {
    const settle = (status: Status | undefined): void => {
      clearTimeout(timer);
      cancelled.removeEventListener('abort', onCancel);
      closing.removeEventListener('abort', onClose);
      resolve(status);
    };
    const onCancel = (): void =>
      settle(
        create(StatusSchema, {
          code: Code.Canceled,
          message: 'The caller cancelled the call.',
        }),
      );
    const onClose = (): void =>
      settle(toStatus(toContractError(closing.reason)));
    const timer =
      deadline > 0
        ? setTimeout(
            () =>
              settle(
                create(StatusSchema, {
                  code: Code.DeadlineExceeded,
                  message: 'The call passed its deadline.',
                }),
              ),
            Math.max(0, deadline - Date.now()),
          )
        : undefined;

    if (cancelled.aborted) {
      onCancel();

      return;
    }

    if (closing.aborted) {
      onClose();

      return;
    }

    cancelled.addEventListener('abort', onCancel);
    closing.addEventListener('abort', onClose);
    void hold.released.then(() => settle(undefined));
  });

/** The states in which an instance takes calls on a handler service. */
const targetStates: ReadonlySet<InstanceRecord['state']> = new Set([
  'connected',
  'active',
  'draining',
  'stopping',
]);
