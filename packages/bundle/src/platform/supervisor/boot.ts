// How a supervisor starts an instance (spec `docs/designs/grpc-processes.md`,
// section 7, "Supervision"): spawn it in a free spawn slot, wait for its
// Hello, then activate it once its providers are active.

import { spawn } from 'node:child_process';

import type { InstanceRecord, InstanceState } from '../router/instances.js';
import { instanceKey } from '../router/instances.js';
import { invalidate, quarantine, stopInstance } from './lifecycle.js';
import {
  type BundleProcess,
  exitOf,
  messageOf,
  trackProcess,
} from './process.js';
import { instanceEnvironment, type SpawnCommand } from './spawn.js';
import { outcomeOf, type SupervisorState } from './state.js';

/** How often a `spawned` instance's state is read for its Hello. */
const helloPollMs = 5;

/**
 * Spawns an incarnation of a generation of a bundle once a spawn slot is
 * free; undefined when `commandOf` threw, the bundle is quarantined or the
 * supervisor is shutting down.
 */
const spawnInstance = async (
  state: SupervisorState,
  bundleId: string,
  generation: number,
  incarnation: number,
): Promise<
  | {
      readonly bundleProcess: BundleProcess;
      readonly hello: Promise<boolean>;
    }
  | undefined
> => {
  const { options, slots } = state;

  await slots.acquire();

  if (state.shuttingDown !== undefined || state.quarantined.has(bundleId)) {
    slots.release();

    return undefined;
  }

  let command: SpawnCommand;

  try {
    command = options.commandOf(bundleId);
  } catch (error) {
    slots.release();
    quarantine(state, bundleId, {
      code: 'invalid_bundle',
      message: `The command of ${bundleId} is unavailable: ${messageOf(error)}`,
    });

    return undefined;
  }

  const instance: Omit<InstanceRecord, 'state'> = {
    bundleId,
    version: state.entries.get(bundleId)?.version ?? '0.0.0',
    generation,
    incarnation,
  };
  const key = instanceKey(instance);
  const { token } = options.instances.issue(instance);

  state.spawnedGenerations.set(
    bundleId,
    Math.max(state.spawnedGenerations.get(bundleId) ?? 0, generation),
  );

  state.current.set(bundleId, key);

  const child = spawn(command.command, [...command.args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: instanceEnvironment({
      base: options.env ?? process.env,
      routerPort: options.router.port,
      token,
      instance,
    }),
  });
  const bundleProcess = trackProcess(bundleId, key, child);

  state.processes.set(key, bundleProcess);

  const hello = awaitHello(state, bundleProcess);

  void hello.finally(() => slots.release());

  return { bundleProcess, hello };
};

/**
 * Resolves once the instance left `spawned`: true when the router accepted
 * its Hello. Declares it invalid at the Hello timeout or when its process
 * exits first.
 */
const awaitHello = (
  state: SupervisorState,
  bundleProcess: BundleProcess,
): Promise<boolean> =>
  new Promise<boolean>((resolve) => {
    const { key, bundleId } = bundleProcess;
    const { helloTimeoutMs } = state.timings;
    const stateOf = (): InstanceState | undefined =>
      state.options.instances.get(key)?.state;
    const settle = (): void => {
      clearTimeout(timeout);
      clearInterval(poll);
      bundleProcess.onExit = undefined;

      const instanceState = stateOf();

      resolve(instanceState === 'connected' || instanceState === 'active');
    };
    const timeout = setTimeout(() => {
      if (stateOf() === 'spawned') {
        invalidate(state, bundleProcess, {
          code: 'invalid_bundle',
          message: `${bundleId} sent no Hello within ${helloTimeoutMs} ms.`,
        });
      }

      settle();
    }, helloTimeoutMs);
    // The router sets `connected` in the table; it has no callback for it.
    const poll = setInterval(() => {
      if (stateOf() !== 'spawned') {
        settle();
      }
    }, helloPollMs);

    bundleProcess.onExit = () => {
      if (stateOf() === 'spawned') {
        invalidate(state, bundleProcess, {
          code: 'invalid_bundle',
          message: `${bundleId} exited before its Hello (${exitOf(bundleProcess)}).`,
        });
      }

      settle();
    };
  });

/**
 * Spawns and activates one incarnation of a bundle; settles its outcome.
 * An instance lost before or during its activation is left to `onLost`,
 * which restarts it.
 */
export const bootBundle = async (
  state: SupervisorState,
  bundleId: string,
  generation: number,
  incarnation: number,
): Promise<void> => {
  const { instances, router, diagnostics } = state.options;
  const spawned = await spawnInstance(state, bundleId, generation, incarnation);

  // Not connected: invalid (quarantined), lost (restarted) or stopping.
  if (spawned === undefined || !(await spawned.hello)) {
    return;
  }

  const { key } = spawned.bundleProcess;

  for (const dependency of state.entries.get(bundleId)?.dependencies ?? []) {
    const outcome = state.outcomes.get(dependency);
    const settled =
      outcome === undefined ? 'quarantined' : await outcome.settled;

    if (settled === 'quarantined') {
      quarantine(state, bundleId, {
        code: 'dependency_quarantined',
        message: `${bundleId} requires ${dependency}, which is quarantined.`,
      });
      await stopInstance(state, key);

      return;
    }
  }

  if (
    state.quarantined.has(bundleId) ||
    state.shuttingDown !== undefined ||
    instances.get(key)?.state !== 'connected'
  ) {
    return;
  }

  const started = Date.now();
  let failure: string | undefined;

  try {
    const status = await router.sendActivate(key);

    if (status.code === 0) {
      state.activated.add(bundleId);
      diagnostics.setState(bundleId, 'active', Date.now() - started);
      outcomeOf(state, bundleId).settle('active');

      const replacement = state.replacements.get(bundleId);

      if (replacement?.generation === generation) {
        replacement.activated(key);
      }

      return;
    }

    failure = status.message;
  } catch (error) {
    failure = messageOf(error);
  }

  if (
    !state.quarantined.has(bundleId) &&
    instances.get(key)?.state !== 'lost'
  ) {
    instances.setState(key, 'stopping');
    quarantine(state, bundleId, { code: 'activate_failed', message: failure });
    await stopInstance(state, key);
  }
};
