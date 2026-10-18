import type { Services } from './context.js';

/**
 * Protocol through which a registration (a tool, a command) receives the
 * services of the bundle that registers it. The runtime calls it with the
 * caller's services before handing the argument to the provider.
 */
export const bindRegistrant: unique symbol = Symbol.for(
  'doric.bind-registrant',
);

export interface Registrable<B> {
  [bindRegistrant](services: Services): B;
}

export const isRegistrable = (value: unknown): value is Registrable<unknown> =>
  (typeof value === 'object' || typeof value === 'function') &&
  value !== null &&
  typeof (value as { [bindRegistrant]?: unknown })[bindRegistrant] ===
    'function';
