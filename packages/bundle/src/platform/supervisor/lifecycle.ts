// How a supervisor ends instances (spec `docs/designs/grpc-processes.md`,
// section 7, "Supervision"): quarantines and their cascade, invalid and lost
// instances with their restarts, stops and drains.

import type { QuarantineReason } from '../../contracts/platform.js';
import type { GenerationLostReport } from '../../runtime/diagnostics.js';
import type { InvalidReason, StreamEnd } from '../router/control.js';
import type { InstanceKey } from '../router/instances.js';
import { type BundleProcess, kill, within } from './process.js';
import { cancelRestart, outcomeOf, type SupervisorState } from './state.js';

/**
 * Quarantines `bundleId` with `reason`, once, and cascades; a publish's new
 * generation that fails instead fails its replacement and leaves the bundle
 * unquarantined.
 */
export const quarantine = (
  state: SupervisorState,
  bundleId: string,
  reason: QuarantineReason,
): void => {
  const replacement = state.replacements.get(bundleId);

  if (replacement !== undefined) {
    replacement.fail(reason.message);

    return;
  }

  if (state.quarantined.has(bundleId)) {
    return;
  }

  state.quarantined.add(bundleId);
  state.generations.delete(bundleId);
  cancelRestart(state, bundleId);
  state.options.diagnostics.quarantine(bundleId, reason);
  state.options.onQuarantine?.(bundleId, reason);
  outcomeOf(state, bundleId).settle('quarantined');
  cascade(state, bundleId);
};

/**
 * Quarantines with `dependency_quarantined`, recursively, every bundle that
 * has been active and requires `bundleId`, and stops its instance without
 * drain. A bundle still booting is the boot's: it waits for its providers.
 */
const cascade = (state: SupervisorState, bundleId: string): void => {
  for (const id of state.scheduled) {
    if (
      state.activated.has(id) &&
      !state.quarantined.has(id) &&
      (state.entries.get(id)?.dependencies ?? []).includes(bundleId)
    ) {
      quarantine(state, id, {
        code: 'dependency_quarantined',
        message: `${id} requires ${bundleId}, which is quarantined.`,
      });

      const key = state.current.get(id);

      if (key !== undefined) {
        void stopInstance(state, key);
      }
    }
  }
};

/** Declares an instance invalid: revokes it, kills it, quarantines. */
export const invalidate = (
  state: SupervisorState,
  bundleProcess: BundleProcess,
  reason: QuarantineReason,
): void => {
  state.options.instances.setState(bundleProcess.key, 'invalid');
  kill(bundleProcess);
  quarantine(state, bundleProcess.bundleId, reason);
};

/** The router's `onInvalid`. */
export const onInvalid = (
  state: SupervisorState,
  key: InstanceKey,
  reason: InvalidReason,
  message: string,
): void => {
  const bundleProcess = state.processes.get(key);

  if (bundleProcess !== undefined) {
    invalidate(state, bundleProcess, { code: reason, message });
  }
};

/**
 * The router's `onLost`: reports the loss, and schedules `restart` of the
 * bundle's current instance as the next incarnation of its generation, or
 * quarantines it after the allowed restarts within the restart window.
 */
export const onLost = (
  state: SupervisorState,
  key: InstanceKey,
  end: StreamEnd,
  restart: (bundleId: string, generation: number, incarnation: number) => void,
): void => {
  const bundleProcess = state.processes.get(key);

  if (bundleProcess === undefined) {
    return;
  }

  const { bundleId } = bundleProcess;
  const { timings } = state;
  const generation = state.options.instances.get(key)?.generation ?? 1;
  const incarnation = state.options.instances.get(key)?.incarnation ?? 1;

  void reportLoss(state, bundleProcess, end, generation, incarnation);

  if (
    state.shuttingDown !== undefined ||
    state.quarantined.has(bundleId) ||
    state.current.get(bundleId) !== key
  ) {
    return;
  }

  const now = Date.now();
  const recent = (state.losses.get(bundleId) ?? []).filter(
    (at) => now - at < timings.restartWindowMs,
  );

  recent.push(now);
  state.losses.set(bundleId, recent);

  const delay = timings.restartDelaysMs[recent.length - 1];

  if (delay === undefined) {
    quarantine(state, bundleId, {
      code: 'process_failed',
      message: `${bundleId} was lost ${recent.length} times within ${timings.restartWindowMs} ms.`,
    });

    return;
  }

  state.restarts.set(
    bundleId,
    setTimeout(() => {
      state.restarts.delete(bundleId);
      restart(bundleId, generation, incarnation + 1);
    }, delay),
  );
};

/**
 * Records `generation_lost` once the lost process has exited, with its exit
 * code or signal; a process still alive at the stop timeout is killed.
 */
const reportLoss = async (
  state: SupervisorState,
  bundleProcess: BundleProcess,
  end: StreamEnd,
  generation: number,
  incarnation: number,
): Promise<void> => {
  await within(bundleProcess.exit, state.timings.stopTimeoutMs);
  kill(bundleProcess);
  await bundleProcess.exit;

  const report: GenerationLostReport = {
    bundleId: bundleProcess.bundleId,
    kind: 'generation_lost',
    message: end.message,
    details: {
      generation,
      incarnation,
      cause: end.cause,
      exitCode: bundleProcess.exitCode,
      signal: bundleProcess.signal,
    },
  };

  state.options.diagnostics.report(report);
};

/** `Supervisor.stopInstance`. */
export const stopInstance = (
  state: SupervisorState,
  key: InstanceKey,
): Promise<void> => {
  const { instances, router } = state.options;
  const bundleProcess = state.processes.get(key);
  const instanceState = instances.get(key)?.state;

  if (
    bundleProcess === undefined ||
    instanceState === undefined ||
    instanceState === 'stopped' ||
    instanceState === 'lost' ||
    instanceState === 'invalid'
  ) {
    return state.stops.get(key) ?? Promise.resolve();
  }

  let stop = state.stops.get(key);

  if (stop === undefined) {
    stop = (async () => {
      const deadline = Date.now() + state.timings.stopTimeoutMs;

      await router.sendStop(key);
      await within(bundleProcess.exit, deadline - Date.now());
      kill(bundleProcess);
      await bundleProcess.exit;
      instances.setState(key, 'stopped');
    })();
    state.stops.set(key, stop);
  }

  return stop;
};

/**
 * Drains an instance with `router.drain`; resolves after its `draining`
 * ack. Once the drain settles the instance is stopped, and the bundle's
 * other live instances hear that it stopped.
 */
export const drainInstance = (
  state: SupervisorState,
  key: InstanceKey,
): Promise<void> => {
  const { router, held } = state.options;
  const drain = router.drain(key, () => held?.(key) ?? false);

  void drain.settled.then(async (outcome) => {
    await stopInstance(state, key);

    if (outcome !== 'lost') {
      await router.announce('stopped', key);
    }
  });

  return drain.acknowledged;
};

/** Whether an instance is `connected`, `active` or `draining`. */
export const isLive = (
  state: SupervisorState,
  key: InstanceKey | undefined,
): key is InstanceKey => {
  const instanceState =
    key === undefined ? undefined : state.options.instances.get(key)?.state;

  return (
    instanceState === 'connected' ||
    instanceState === 'active' ||
    instanceState === 'draining'
  );
};
