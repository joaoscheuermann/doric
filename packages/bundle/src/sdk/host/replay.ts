// The host SDK's side of registrations across a provider's instances (spec
// `docs/designs/grpc-processes.md`, section 4, "When an instance ends" and
// "When a provider changes"): `context.services`, `context.registrations`
// and `context.instances` over one transport factory, the replay of tracked
// registrations on `ProviderChanged` and the `InstanceGone` handlers.

import { type DescService, getOption, hasOption } from '@bufbuild/protobuf';
import { type Client, createClient, type Transport } from '@connectrpc/connect';

import type { Log } from '../../contracts/basic/log.js';
import {
  contract as contractOption,
  hooks as hooksOption,
} from '../../contracts/gen/doric/platform/v1/options_pb.js';
import { instanceKey } from '../../platform/router/instances.js';
import { withResumableStreams } from '../../runtime/resumable.js';
import type {
  BundleInstance,
  HostInstances,
  HostRegistrations,
  HostServices,
  TrackOptions,
  UseOptions,
} from './context.js';

export interface ReplaysOptions {
  /** The transport of the calls a client of `options` makes. */
  readonly transport: (options: UseOptions) => Transport;
  /** Sends `ReplayDone { contractId, instance }` on the control stream. */
  readonly replayDone: (contractId: string, instance: BundleInstance) => void;
  /** Where a failed replay and a throwing handler are logged. */
  readonly log: Log;
}

/** The parts of a `HostContext` that registrations involve. */
export interface Replays {
  readonly services: HostServices;
  readonly registrations: HostRegistrations;
  readonly instances: HostInstances;
  /**
   * `ProviderChanged { contractId, instance }`: queues the new calls to the
   * contract, replays its live registrations to `instance` in the order they
   * were tracked, each call with `doric-target` naming `instance`, sends `ReplayDone` and releases the queue. A second one
   * for the same contract runs after the first.
   */
  providerChanged(contractId: string, instance: BundleInstance): void;
  /** `InstanceGone { instance }`: runs every `onGone` handler, in order. */
  instanceGone(instance: BundleInstance): void;
}

/** One registration `track` keeps for replay. */
interface Tracked {
  readonly contractId: string | undefined;
  /** `TrackOptions.provider`: the only provider bundle it is replayed to. */
  readonly provider: string | undefined;
  /**
   * Calls `register` again, with a client the replay queue does not hold
   * whose calls carry `doric-target: target`.
   */
  readonly replay: (target: string) => Promise<void>;
}

/**
 * The services, registrations and instances of one host part. A replay's
 * calls go out at once; the other calls to the contract wait for the replay
 * (see `HostServices.use`).
 */
export const createReplays = (options: ReplaysOptions): Replays => {
  const tracked: Tracked[] = [];
  const goneHandlers = new Set<{ run: (instance: BundleInstance) => void }>();
  /** The replay in progress of each contract, until it settled. */
  const replaying = new Map<string, Promise<void>>();

  const gated = (
    contractId: string | undefined,
    inner: Transport,
  ): Transport => {
    const settled = async (): Promise<void> => {
      if (contractId === undefined) {
        return;
      }

      for (
        let replay = replaying.get(contractId);
        replay !== undefined;
        replay = replaying.get(contractId)
      ) {
        await replay;
      }
    };

    return {
      unary: async (...args) => {
        await settled();

        return await inner.unary(...args);
      },
      stream: async (...args) => {
        await settled();

        return await inner.stream(...args);
      },
    };
  };

  const use = <S extends DescService>(
    ref: S,
    useOptions: UseOptions<S> = {},
  ): Client<S> =>
    withResumableStreams(
      ref,
      createClient(
        ref,
        gated(contractIdOf(ref), options.transport(useOptionsOf(useOptions))),
      ),
      useOptions.resume,
    );

  const replay = async (
    contractId: string,
    instance: BundleInstance,
  ): Promise<void> => {
    for (const entry of [...tracked]) {
      if (
        entry.contractId !== contractId ||
        !tracked.includes(entry) ||
        (entry.provider !== undefined && entry.provider !== instance.bundleId)
      ) {
        continue;
      }

      try {
        await entry.replay(instanceKey(instance));
      } catch (error) {
        options.log.error('registration replay failed', {
          contract: contractId,
          error: messageOf(error),
        });
      }
    }

    options.replayDone(contractId, instance);
  };

  return {
    services: { use },
    registrations: {
      track: async <S extends DescService, R>(
        ref: S,
        register: (client: Client<S>) => Promise<R>,
        trackOptions: TrackOptions<R> = {},
      ) => {
        let current = await register(use<S>(ref, trackOptions));
        const entry: Tracked = {
          contractId: contractIdOf(ref),
          provider: trackOptions.provider,
          replay: async (target) => {
            const result = await register(
              createClient(
                ref,
                options.transport({ ...useOptionsOf(trackOptions), target }),
              ),
            );

            current = result;

            try {
              trackOptions.onReplayed?.(result);
            } catch (error) {
              options.log.error('onReplayed failed', {
                contract: entry.contractId,
                error: messageOf(error),
              });
            }
          },
        };

        tracked.push(entry);

        return {
          get current() {
            return current;
          },
          untrack: () => {
            const index = tracked.indexOf(entry);

            if (index !== -1) {
              tracked.splice(index, 1);
            }
          },
        };
      },
    },
    instances: {
      onGone: (handler) => {
        const entry = { run: handler };

        goneHandlers.add(entry);

        return () => {
          goneHandlers.delete(entry);
        };
      },
    },
    providerChanged: (contractId, instance) => {
      const previous = replaying.get(contractId) ?? Promise.resolve();
      const run = previous.then(() => replay(contractId, instance));

      replaying.set(contractId, run);
      void run.finally(() => {
        if (replaying.get(contractId) === run) {
          replaying.delete(contractId);
        }
      });
    },
    instanceGone: (instance) => {
      for (const { run } of [...goneHandlers]) {
        try {
          run(instance);
        } catch (error) {
          options.log.error('onGone handler failed', {
            error: messageOf(error),
          });
        }
      }
    },
  };
};

/** `provider` and `target` of `options`, without the other fields. */
const useOptionsOf = <S extends DescService>(
  options: UseOptions<S>,
): UseOptions => ({
  ...(options.provider === undefined ? {} : { provider: options.provider }),
  ...(options.target === undefined ? {} : { target: options.target }),
});

/**
 * The id of the contract that declares `service`: the file option
 * `(doric.platform.v1.hooks)` or `(doric.platform.v1.contract)`.
 */
const contractIdOf = (service: DescService): string | undefined => {
  const { file } = service;

  if (hasOption(file, hooksOption)) {
    return getOption(file, hooksOption).id;
  }

  return hasOption(file, contractOption)
    ? getOption(file, contractOption).id
    : undefined;
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
