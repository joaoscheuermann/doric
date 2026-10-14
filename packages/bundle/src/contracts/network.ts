import { disposableSchema, functionSchema } from './basic/common.js';
import type { Disposable } from './context.js';
import { ref } from './define.js';

/**
 * Native server handles; local to the host process and never serialized.
 *
 * `http` is the shared request router the host's routes are registered on and
 * `sockets` the Socket.IO server over the same listener. `server`, the
 * `http.Server` both are attached to, is here for the protocols a request
 * router cannot express: a WebSocket handshake is an HTTP `upgrade` that no
 * route sees, so the bundle that serves one attaches its own `upgrade`
 * listener to `server`. A bundle never calls `listen` on it — the kernel owns
 * the address, the bind and the close, and runs the listener's cleanup when
 * the bundle deactivates.
 */
export interface NetworkResources {
  readonly http: object;
  /** The host's shared `http.Server`; a bundle attaches `upgrade` here. */
  readonly server: object;
  readonly sockets: object;
}

export type NetworkListener = (
  resources: NetworkResources,
) => (() => void) | undefined;

/** Installs handlers on the host's shared listeners during bundle activation. */
export interface DoricNetwork {
  register(listener: NetworkListener): Disposable;
}

export const DoricNetworkV1 = ref<DoricNetwork>('doric.network/v1');

export const networkMethods = {
  register: {
    input: functionSchema<NetworkListener>(),
    output: disposableSchema,
  },
} as const;
