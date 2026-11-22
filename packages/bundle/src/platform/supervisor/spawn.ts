// Spawning a bundle's process (spec `docs/designs/grpc-processes.md`,
// section 7, "Spawn"): the command the supervisor is given for a bundle
// (A64) and the environment every instance starts with.

import type { InstanceRecord } from '../router/instances.js';

/**
 * What the supervisor runs for a bundle, the answer of `commandOf(bundleId)`
 * (A64): `child_process.spawn(command, args, { stdio: ['ignore', 'pipe',
 * 'pipe'], env })`. The host's answers the staged `host/command.json` when it
 * exists and otherwise `<bundles dir>/<id>/host/doric-<id>` with no
 * arguments; the phase 2 tests answer `node <fixture>/main.js`.
 */
export interface SpawnCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * The environment of an instance's process: every variable of `base` (the
 * host's environment, as a generation process gets today), plus, replacing
 * any of the same name:
 * - `DORIC_ROUTER_URL`: `http://127.0.0.1:<routerPort>`;
 * - `DORIC_INSTANCE_TOKEN`: `token`;
 * - `DORIC_BUNDLE_ID`, `DORIC_GENERATION`, `DORIC_INCARNATION`: the
 *   instance, the numbers in decimal;
 * - `DORIC_BUNDLE_CACHE`: `<base.DORIC_STATE_DIR or /var/lib/doric>/bundles/
 *   <bundleId>/<version>`.
 *
 * Pure: returns a new object, leaves `base` unchanged, and never throws.
 */
export const instanceEnvironment = (options: {
  readonly base: NodeJS.ProcessEnv;
  readonly routerPort: number;
  readonly token: string;
  readonly instance: Omit<InstanceRecord, 'state'>;
}): NodeJS.ProcessEnv => {
  const { base, routerPort, token, instance } = options;
  const stateDir = base.DORIC_STATE_DIR ?? '/var/lib/doric';

  return {
    ...base,
    DORIC_ROUTER_URL: `http://127.0.0.1:${routerPort}`,
    DORIC_INSTANCE_TOKEN: token,
    DORIC_BUNDLE_ID: instance.bundleId,
    DORIC_GENERATION: String(instance.generation),
    DORIC_INCARNATION: String(instance.incarnation),
    DORIC_BUNDLE_CACHE: `${stateDir}/bundles/${instance.bundleId}/${instance.version}`,
  };
};
