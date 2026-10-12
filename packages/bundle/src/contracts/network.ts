import { disposableSchema, functionSchema } from './basic/common.js';
import type { Disposable } from './context.js';
import { ref } from './define.js';

/** Native server handles; local to the host process and never serialized. */
export interface NetworkResources {
  readonly http: object;
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
