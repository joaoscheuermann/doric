// The supervisor (spec `docs/designs/grpc-processes.md`, sections 6 and 7):
// spawns each scheduled bundle's process, activates it once its providers
// are active, and kills, quarantines, restarts and stops instances.

import type { QuarantineReason } from '../../contracts/platform.js';
import type { ResolvedEnvironment } from '../../runtime/catalog.js';
import type {
  DiagnosticsStore,
  GenerationFailedReport,
} from '../../runtime/diagnostics.js';
import type {
  InstanceKey,
  InstanceState,
  InstanceTable,
} from '../router/instances.js';
import type { Router } from '../router/listener.js';
import { callRoutesOf } from '../router/route.js';
import { bootBundle } from './boot.js';
import {
  drainInstance,
  isLive,
  onInvalid,
  onLost,
  stopInstance,
} from './lifecycle.js';
import { kill, within } from './process.js';
import { type PublishTarget, signatureOf } from './publish.js';
import type { RouterRelay } from './router-relay.js';
import type { SpawnCommand } from './spawn.js';
import {
  adoptResolution,
  cancelRestart,
  createOutcome,
  createSlots,
  outcomeOf,
  type SupervisorState,
} from './state.js';
import { timings as platformTimings, type Timings } from './timings.js';

/**
 * What the supervisor writes in the diagnostics: bundle states, quarantines
 * and the reports of section 15 (`generation_lost`, `generation_failed`;
 * see `PlatformReport` in `runtime/diagnostics.ts`), kept in the per-bundle
 * error list. A {@link DiagnosticsStore} is one.
 */
export type SupervisorDiagnostics = Pick<
  DiagnosticsStore,
  'setState' | 'quarantine' | 'report'
>;

export interface SupervisorOptions {
  /** The started router; its `port` goes into `DORIC_ROUTER_URL`. */
  readonly router: Router;
  /** The router's relay; the supervisor connects to it when started. */
  readonly relay: RouterRelay;
  /** The table the router reads; the supervisor issues every token in it. */
  readonly instances: InstanceTable;
  /**
   * The host environment's resolution: `order` is the activation order, an
   * entry's `dependencies` the bundles its `host.requires` names (an
   * `optional` dependency is not among them), and only `scheduled` entries
   * are spawned.
   */
  readonly resolved: ResolvedEnvironment;
  /**
   * The command of a bundle (A64), asked at each spawn. A call that throws
   * counts as an exit before the Hello: the bundle is quarantined with
   * `invalid_bundle` and the error's message.
   */
  readonly commandOf: (bundleId: string) => SpawnCommand;
  /**
   * The SHA-256 of a bundle's executable as it is now (section 6,
   * "Publish"), read once per bundle when the boot spawns its generation 1
   * and recorded in its `BundleGeneration.signature`; a publish reads it
   * again for the next resolution. Must not throw. When undefined every
   * digest is `''`, so a publish sees no executable change.
   */
  readonly digestOf?: (bundleId: string) => string;
  /** `PlatformOptions.hostPart`; undefined: every scheduled bundle has a host part. */
  readonly hostPart?: (bundleId: string) => boolean;
  /**
   * Whether an instance has a work hold now (`doric.generation/v1.Hold`,
   * `GenerationPlatformService.holdsOf`), read by the drain check
   * (`Router.drain`). No instance is held when undefined. Must not throw.
   */
  readonly held?: (key: InstanceKey) => boolean;
  /** The base of every instance's environment; `process.env` when undefined. */
  readonly env?: NodeJS.ProcessEnv;
  /** The platform's `timings` when undefined; tests pass shorter ones. */
  readonly timings?: Timings;
  readonly diagnostics: SupervisorDiagnostics;
  /**
   * Called once per quarantine the supervisor decides, after the diagnostics
   * hold it, with the bundle and the reason it recorded. The platform's
   * `required` check listens here. Must not throw.
   */
  readonly onQuarantine?: (bundleId: string, reason: QuarantineReason) => void;
}

/**
 * A running supervisor (section 7). The states it sets in the instance table
 * are `spawned` (with the token), `stopping` on an activation failure,
 * `stopped`, and `invalid` for a Hello timeout or an exit before the Hello;
 * the router sets the others. Every instance it spawns gets the environment
 * of `instanceEnvironment` (`spawn.ts`) and `stdio: ['ignore', 'pipe',
 * 'pipe']`; at most `timings.spawnConcurrency` instances are `spawned` at
 * once, and an instance's Hello timeout counts from its own spawn.
 *
 * Quarantines, each recorded with `diagnostics.quarantine` and passed to
 * `onQuarantine`; an instance quarantined for `invalid_bundle` or
 * `health_timeout` gets `SIGKILL` and is never restarted:
 * - no Hello within the Hello timeout, an exit before the Hello, or the
 *   router's `onInvalid` with `invalid_bundle`: `invalid_bundle`, with the
 *   router's message when it gave one;
 * - the router's `onInvalid` with `health_timeout`: `health_timeout`;
 * - an `ActivateResult` with a non-zero code, or `DEADLINE_EXCEEDED` at the
 *   activation timeout: `activate_failed` with the status's message; the
 *   instance is stopped;
 * - a loss after the allowed restarts within the restart window (the
 *   fourth with `timings.restartDelaysMs` of length 3): `process_failed`;
 * - after a bundle's quarantine, every bundle that has been active and
 *   lists it in its `dependencies`: `dependency_quarantined`, recursively;
 *   its instance is stopped without drain, as by `stopInstance`, and a
 *   restart it had scheduled is cancelled. A bundle that has not been
 *   active yet is quarantined so by its boot, which waits for its providers.
 *
 * A loss (`onLost`) is recorded as `generation_lost` with the instance and
 * the process's exit code or signal once the process has exited; a lost
 * process still alive at the stop timeout gets `SIGKILL` first. The bundle's
 * current instance, active or `connected` and before or during its
 * activation, is spawned again as the next incarnation of its generation
 * after `timings.restartDelaysMs[n - 1]` for the n-th loss within
 * `timings.restartWindowMs` (losses older than the window are not counted),
 * and activated once its providers are active. A lost instance that is not
 * the bundle's current one (a draining one), of a quarantined bundle or
 * during the shutdown is not restarted.
 *
 * The supervisor is the {@link PublishTarget} of `publish` (`publish.ts`):
 * it tracks each bundle's running generation (`generationOf`), starting
 * with generation 1 of every scheduled bundle at the boot, signed with
 * `options.resolved` and `options.digestOf`; a crash restarts the next
 * incarnation of the same generation, so `core`, which a publish never
 * replaces, keeps generation 1 for the life of the host (A48, D32). A
 * quarantine drops the bundle's running generation. A drained instance is
 * stopped when its drain settles (`Router.drain`), and the bundle's other
 * live instances then get `GenerationChanged { event: "stopped" }`
 * (`Router.announce`); it is never restarted.
 */
export interface Supervisor extends PublishTarget {
  /**
   * Spawns generation 1 of every scheduled bundle and sends `Activate` to
   * each once every bundle in its `dependencies` is `active`; a bundle whose
   * dependency is quarantined is never activated. Resolves when every
   * scheduled bundle is `active` or quarantined, after the restarts of an
   * instance lost while it booted, or the shutdown starts, with its state in the
   * diagnostics (`active` with its activation time, or `quarantined`).
   * Never rejects for a bundle's failure; rejects with a `TypeError` when
   * called a second time.
   */
  boot(): Promise<void>;
  /**
   * The state of the bundle's current instance: the newest incarnation of
   * its newest generation. `undefined` for a bundle never spawned.
   */
  state(bundleId: string): InstanceState | undefined;
  /**
   * Stops one instance (section 7, "Stop"): `Stop` through the router, then
   * `SIGKILL` when the process is alive at the stop timeout. Resolves once
   * the process has exited and the instance is `stopped`; never rejects. A
   * key the supervisor did not spawn, or an instance already `stopped`,
   * `lost` or `invalid`, resolves at once. A stopped instance is not
   * restarted.
   */
  stopInstance(key: InstanceKey): Promise<void>;
  /**
   * Stops every instance by dependency level, in reverse activation order
   * (section 7, "Host shutdown"), sends `SIGKILL` to every process alive at
   * the shutdown deadline, and resolves when every process has exited. Never
   * rejects; a second call resolves with the first.
   *
   * Ends every process by `deadlineAt` (epoch ms; default `Date.now() +
   * timings.shutdownDeadlineMs` when the call starts): the level stops are
   * cut and the rest `SIGKILL`ed at that time.
   */
  shutdown(deadlineAt?: number): Promise<void>;
}

/**
 * Starts the supervisor: connects it to `relay`, and spawns nothing until
 * `boot`. Throws a `TypeError` when `relay` is already connected.
 */
export const startSupervisor = (options: SupervisorOptions): Supervisor => {
  const { router, instances, diagnostics } = options;
  const timings = options.timings ?? platformTimings;
  const digestOf = options.digestOf ?? (() => '');
  let startShutdown: () => void = () => {};
  const state: SupervisorState = {
    options,
    timings,
    resolved: options.resolved,
    entries: new Map(),
    scheduled: [],
    hostless: new Set(),
    generations: new Map(),
    spawnedGenerations: new Map(),
    replacements: new Map(),
    processes: new Map(),
    current: new Map(),
    outcomes: new Map(),
    quarantined: new Set(),
    activated: new Set(),
    losses: new Map(),
    restarts: new Map(),
    stops: new Map(),
    slots: createSlots(timings.spawnConcurrency),
    shuttingDown: undefined,
    stopped: new Promise<void>((resolve) => {
      startShutdown = resolve;
    }),
  };
  let booting: Promise<void> | undefined;

  adoptResolution(state, options.resolved);

  /** Records a hostless bundle as active, without a process (D5). */
  const settleHostless = (bundleId: string, digest: string): void => {
    state.generations.set(bundleId, {
      bundleId,
      generation: state.generations.get(bundleId)?.generation ?? 1,
      signature: signatureOf(state.resolved, bundleId, digest) ?? '',
    });
    diagnostics.setState(bundleId, 'active');
    outcomeOf(state, bundleId).settle('active');
  };

  const replace = async (
    bundleId: string,
    digest: string,
  ): Promise<'active' | 'failed'> => {
    if (state.hostless.has(bundleId)) {
      settleHostless(bundleId, digest);

      return 'active';
    }

    const previous = state.current.get(bundleId);
    const running = state.generations.get(bundleId);
    const generation =
      (running?.generation ?? state.spawnedGenerations.get(bundleId) ?? 0) + 1;
    const outcome = createOutcome();

    state.quarantined.delete(bundleId);
    cancelRestart(state, bundleId);
    state.outcomes.set(bundleId, outcome);

    const answer = await new Promise<
      { readonly key: InstanceKey } | { readonly reason: string }
    >((resolve) => {
      state.replacements.set(bundleId, {
        generation,
        activated: (key) => {
          state.replacements.delete(bundleId);
          resolve({ key });
        },
        fail: (message) => {
          state.replacements.delete(bundleId);
          cancelRestart(state, bundleId);

          if (previous === undefined) {
            state.current.delete(bundleId);
          } else {
            state.current.set(bundleId, previous);
          }

          outcome.settle(running === undefined ? 'quarantined' : 'active');
          resolve({ reason: message });
        },
      });
      void bootBundle(state, bundleId, generation, 1);
      void state.stopped.then(() =>
        state.replacements
          .get(bundleId)
          ?.fail(`The host shut down before ${bundleId} became active.`),
      );
    });

    if (!('key' in answer)) {
      const report: GenerationFailedReport = {
        bundleId,
        kind: 'generation_failed',
        message: answer.reason,
        details: { generation },
      };

      diagnostics.report(report);

      return 'failed';
    }

    state.generations.delete(bundleId);
    state.generations.set(bundleId, {
      bundleId,
      generation,
      signature: signatureOf(state.resolved, bundleId, digest) ?? '',
    });

    if (isLive(state, previous)) {
      await drainInstance(state, previous);
    }

    await router.announce('activated', answer.key);

    return 'active';
  };

  options.relay.connect({
    onInvalid: (key, reason, message) => onInvalid(state, key, reason, message),
    onLost: (key, end) =>
      onLost(state, key, end, (bundleId, generation, incarnation) => {
        void bootBundle(state, bundleId, generation, incarnation);
      }),
  });

  return {
    generationOf: (bundleId) => state.generations.get(bundleId),
    runningBundles: () => [...state.generations.keys()],
    adopt: (next) => {
      adoptResolution(state, next);
      router.setRoutes(callRoutesOf(next));
    },
    replace,
    retire: async (bundleId) => {
      const key = state.current.get(bundleId);

      state.generations.delete(bundleId);
      state.current.delete(bundleId);
      cancelRestart(state, bundleId);

      if (isLive(state, key)) {
        await drainInstance(state, key);
      }
    },
    boot: () => {
      if (booting !== undefined) {
        return Promise.reject(
          new TypeError('The supervisor has already booted.'),
        );
      }

      for (const id of state.hostless) {
        settleHostless(id, digestOf(id));
      }

      for (const id of state.scheduled) {
        outcomeOf(state, id);
        state.generations.set(id, {
          bundleId: id,
          generation: 1,
          signature: signatureOf(state.resolved, id, digestOf(id)) ?? '',
        });
      }

      booting = Promise.all(
        state.scheduled.map(async (id) => {
          await bootBundle(state, id, 1, 1);
          // A bundle lost while it booted is active or quarantined later.
          await Promise.race([outcomeOf(state, id).settled, state.stopped]);
        }),
      ).then(() => {});

      return booting;
    },
    state: (bundleId) => {
      const key = state.current.get(bundleId);

      return key === undefined ? undefined : instances.get(key)?.state;
    },
    stopInstance: (key) => stopInstance(state, key),
    shutdown: (deadlineAt) => {
      const deadline = deadlineAt ?? Date.now() + timings.shutdownDeadlineMs;

      state.shuttingDown ??= (async () => {
        startShutdown();
        state.slots.close();

        for (const timer of state.restarts.values()) {
          clearTimeout(timer);
        }

        state.restarts.clear();

        const { processes } = state;
        const stopLevels = async (): Promise<void> => {
          for (const ids of levels(state.scheduled, state.entries)) {
            await Promise.all(
              ids.flatMap((id) =>
                [...processes.values()]
                  .filter(({ bundleId }) => bundleId === id)
                  .map(({ key }) => stopInstance(state, key)),
              ),
            );
          }
        };

        await within(stopLevels(), deadline - Date.now());

        for (const bundleProcess of processes.values()) {
          kill(bundleProcess);
        }

        await Promise.all([...processes.values()].map(({ exit }) => exit));
      })();

      return state.shuttingDown;
    },
  };
};

/**
 * The scheduled bundles by dependency level, deepest first (0: without
 * dependencies), each level in reverse scheduled order: the shutdown order.
 */
const levels = (
  scheduled: readonly string[],
  entries: SupervisorState['entries'],
): string[][] => {
  const levelOf = new Map<string, number>();
  const visit = (id: string, path: Set<string>): number => {
    const known = levelOf.get(id);

    if (known !== undefined) {
      return known;
    }

    path.add(id);

    let level = 0;

    for (const dependency of entries.get(id)?.dependencies ?? []) {
      if (!path.has(dependency)) {
        level = Math.max(level, visit(dependency, path) + 1);
      }
    }

    path.delete(id);
    levelOf.set(id, level);

    return level;
  };
  const byLevel = new Map<number, string[]>();

  for (const id of scheduled) {
    const level = visit(id, new Set());

    byLevel.set(level, [...(byLevel.get(level) ?? []), id]);
  }

  return [...byLevel.entries()]
    .sort(([left], [right]) => right - left)
    .map(([, ids]) => ids.reverse());
};
