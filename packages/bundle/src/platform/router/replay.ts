// Registrations across a provider's instances, on the router's side (spec
// `docs/designs/grpc-processes.md`, section 4, "When an instance ends" and
// "When a provider changes"): the `InstanceGone` and `ProviderChanged`
// frames the router sends from the states of the instance table, and the
// holds of the calls to a new provider instance until its consumers answered
// `ReplayDone` or the replay timeout passed.

import type { ReplayDone } from '../../contracts/gen/doric/platform/v1/control_pb.js';
import type { Status } from '../../contracts/gen/google/rpc/status_pb.js';
import type { Timings } from '../supervisor/timings.js';
import type { CallRelay, ControlChannel } from './calls.js';
import type { RouterDiagnostics } from './control.js';
import {
  type InstanceKey,
  type InstanceRecord,
  type InstanceState,
  type InstanceTable,
  instanceKey,
  instanceOf,
} from './instances.js';
import type { CallRoutes } from './route.js';

/**
 * One `ProviderChanged` the router sent for a new provider instance: the
 * consumer instance it went to and the contract it named. The consumer
 * answers it with `ReplayDone { contractId, instance }`.
 */
export interface ReplayParty {
  readonly consumer: InstanceKey;
  readonly contractId: string;
}

/**
 * The calls to one new provider instance held until its consumers replayed
 * their registrations (section 4, "When a provider changes"). Released
 * once: when no party is pending, or on {@link release}.
 */
export interface ReplayHold {
  /** The provider instance whose calls are held. */
  readonly provider: InstanceKey;
  /** The parties that have not answered `ReplayDone`; empty once released. */
  readonly pending: readonly ReplayParty[];
  /**
   * The party answered `ReplayDone`: it is no longer pending, and the last
   * one releases the hold. Answers `false`, changing nothing, for a party
   * that is not pending (unknown, already done, or after the release).
   */
  done(party: ReplayParty): boolean;
  /**
   * Releases the hold now, pending parties included (the replay timeout, or
   * the provider's control stream ended). Idempotent.
   */
  release(): void;
  /** Resolves when the hold is released, by either way. Never rejects. */
  readonly released: Promise<void>;
}

/**
 * A hold of the calls to `provider` for the replay of `parties`; released at
 * once when `parties` is empty. See {@link ReplayHold}.
 */
export const createReplayHold = (
  provider: InstanceKey,
  parties: readonly ReplayParty[],
): ReplayHold => {
  let pending: readonly ReplayParty[] = [...parties];
  let markReleased!: () => void;
  const released = new Promise<void>((resolve) => {
    markReleased = resolve;
  });
  const release = (): void => {
    pending = [];
    markReleased();
  };

  if (pending.length === 0) {
    release();
  }

  return {
    provider,
    get pending() {
      return pending;
    },
    done: (party) => {
      const index = pending.findIndex(
        ({ consumer, contractId }) =>
          consumer === party.consumer && contractId === party.contractId,
      );

      if (index === -1) {
        return false;
      }

      pending = pending.filter((_, at) => at !== index);

      if (pending.length === 0) {
        release();
      }

      return true;
    },
    release,
    released,
  };
};

export interface ReplayCoordinatorOptions {
  /** The table whose states the coordinator follows. */
  readonly instances: InstanceTable;
  readonly routes: CallRoutes;
  /** Where the calls to a new provider instance are held. */
  readonly relay: Pick<CallRelay, 'holdForReplay'>;
  /** `replayTimeoutMs` bounds each hold. */
  readonly timings: Timings;
  readonly diagnostics: RouterDiagnostics;
  /** The accepted control stream of each instance that has one. */
  readonly channels: () => Iterable<readonly [InstanceKey, ControlChannel]>;
}

/** The router's side of section 4, fed by the control streams. */
export interface ReplayCoordinator {
  /** `consumer`'s control stream sent `ReplayDone`; an unmatched one is ignored. */
  replayDone(consumer: InstanceKey, done: ReplayDone): void;
  /**
   * The control stream of `key` ended: a hold of the calls to it is
   * released, and it is no longer waited for as a consumer, unreported.
   */
  channelEnded(key: InstanceKey): void;
  /** Stops following the table and releases every hold. Idempotent. */
  close(): void;
}

const goneStates: ReadonlySet<InstanceState> = new Set([
  'stopped',
  'lost',
  'invalid',
]);

/** The instances `InstanceGone` goes to. */
const goneAudienceStates: ReadonlySet<InstanceState> = new Set([
  'connected',
  'active',
  'draining',
]);

/** The instances `ProviderChanged` goes to. */
const consumerStates: ReadonlySet<InstanceState> = new Set([
  'active',
  'draining',
]);

/**
 * Follows `options.instances` from now on and sends the frames of section 4
 * as the router's doc comment (`Router`, `listener.ts`) describes them:
 * `InstanceGone` once per instance that becomes `stopped`, `lost` or
 * `invalid`; `ProviderChanged`, a hold and its replay timeout once per
 * instance that becomes `active`.
 */
export const createReplayCoordinator = (
  options: ReplayCoordinatorOptions,
): ReplayCoordinator => {
  const { instances, routes, diagnostics } = options;
  const gone = new Set<InstanceKey>();
  const activated = new Set<InstanceKey>();
  const holds = new Map<InstanceKey, ReplayHold>();
  const timers = new Set<NodeJS.Timeout>();

  const report: RouterDiagnostics['registrationReplay'] = (...report) => {
    try {
      diagnostics.registrationReplay(...report);
    } catch {
      // A throw of the diagnostics is ignored.
    }
  };

  /** The accepted streams whose instance is in one of `states`. */
  const live = function* (
    states: ReadonlySet<InstanceState>,
  ): Generator<readonly [InstanceRecord, ControlChannel]> {
    for (const [key, channel] of options.channels()) {
      const record = instances.get(key);

      if (record !== undefined && states.has(record.state)) {
        yield [record, channel];
      }
    }
  };

  const sendGone = (record: InstanceRecord): void => {
    const host = routes.declarationsOf(record.bundleId, 'host');
    const providers = new Set(
      [...(host?.requires ?? []), ...(host?.optional ?? [])].flatMap(
        (contractId) => routes.providersOf(contractId),
      ),
    );
    const instance = instanceOf(record);

    for (const [provider, channel] of live(goneAudienceStates)) {
      if (providers.has(provider.bundleId)) {
        channel.send({ frame: { case: 'instanceGone', value: { instance } } });
      }
    }
  };

  const sendProviderChanged = (record: InstanceRecord): void => {
    const provider = instanceKey(record);
    const instance = instanceOf(record);
    const frames: { channel: ControlChannel; contractId: string }[] = [];
    const parties: ReplayParty[] = [];

    for (const contractId of routes.declarationsOf(record.bundleId, 'host')
      ?.provides ?? []) {
      const consumers = new Set(routes.consumersOf(contractId));

      for (const [consumer, channel] of live(consumerStates)) {
        const key = instanceKey(consumer);

        if (key !== provider && consumers.has(consumer.bundleId)) {
          frames.push({ channel, contractId });
          parties.push({ consumer: key, contractId });
        }
      }
    }

    if (parties.length === 0) {
      return;
    }

    const hold = options.relay.holdForReplay(
      provider,
      parties,
      (party, status: Status) =>
        report(
          'registration_replay_failed',
          party.consumer,
          provider,
          status.message,
        ),
    );
    const timer = setTimeout(() => {
      timers.delete(timer);

      for (const consumer of new Set(hold.pending.map((p) => p.consumer))) {
        report(
          'registration_replay_late',
          consumer,
          provider,
          `${consumer} did not answer ReplayDone for ${provider} within ${options.timings.replayTimeoutMs} ms.`,
        );
      }

      hold.release();
    }, options.timings.replayTimeoutMs);

    timers.add(timer);
    holds.set(provider, hold);
    void hold.released.then(() => {
      clearTimeout(timer);
      timers.delete(timer);

      if (holds.get(provider) === hold) {
        holds.delete(provider);
      }
    });

    for (const { channel, contractId } of frames) {
      channel.send({
        frame: { case: 'providerChanged', value: { contractId, instance } },
      });
    }
  };

  /** `key` is no longer a provider to hold for nor a consumer to wait for. */
  const forget = (key: InstanceKey): void => {
    holds.get(key)?.release();

    for (const hold of [...holds.values()]) {
      for (const party of hold.pending) {
        if (party.consumer === key) {
          hold.done(party);
        }
      }
    }
  };

  const unsubscribe = instances.subscribe((record) => {
    const key = instanceKey(record);

    if (goneStates.has(record.state)) {
      if (!gone.has(key)) {
        gone.add(key);
        forget(key);
        sendGone(record);
      }

      return;
    }

    if (record.state === 'active' && !activated.has(key)) {
      activated.add(key);
      sendProviderChanged(record);
    }
  });

  return {
    replayDone: (consumer, done) => {
      if (done.instance === undefined) {
        return;
      }

      holds
        .get(instanceKey(done.instance))
        ?.done({ consumer, contractId: done.contractId });
    },
    channelEnded: forget,
    close: () => {
      unsubscribe();

      for (const timer of timers) {
        clearTimeout(timer);
      }

      timers.clear();

      for (const hold of [...holds.values()]) {
        hold.release();
      }
    },
  };
};
