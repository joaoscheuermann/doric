// The router's way to the supervisor (spec `docs/designs/grpc-processes.md`,
// section 7): the router starts first, so its `onInvalid` and `onLost` are
// kept until the supervisor connects.

import type { RouterOptions } from '../router/listener.js';

/** The two callbacks through which the router reports to the supervisor. */
export type RouterEvents = Pick<RouterOptions, 'onInvalid' | 'onLost'>;

/**
 * The router is started before the supervisor, which needs its port; the
 * relay is passed to `startRouter` as its `onInvalid` and `onLost`, and the
 * supervisor connects to it. An event that arrives before `connect` is kept
 * and delivered, in arrival order, by `connect`; every later event is
 * delivered at once.
 */
export interface RouterRelay extends RouterEvents {
  /**
   * Delivers every event kept so far to `target`, then every later one.
   * Throws a `TypeError` when the relay is already connected.
   */
  connect(target: RouterEvents): void;
}

/** A new relay, connected to nothing. */
export const createRouterRelay = (): RouterRelay => {
  const kept: ((target: RouterEvents) => void)[] = [];
  let connected: RouterEvents | undefined;
  const deliver = (event: (target: RouterEvents) => void): void => {
    if (connected === undefined) {
      kept.push(event);
    } else {
      event(connected);
    }
  };
  let connecting = false;

  return {
    onInvalid: (key, reason, message) =>
      deliver((target) => target.onInvalid(key, reason, message)),
    onLost: (key, end) => deliver((target) => target.onLost(key, end)),
    connect: (target) => {
      if (connecting) {
        throw new TypeError('The router relay is already connected.');
      }

      connecting = true;

      // An event that arrives while the kept ones are delivered is kept too,
      // so the arrival order holds.
      for (
        let event = kept.shift();
        event !== undefined;
        event = kept.shift()
      ) {
        event(target);
      }

      connected = target;
    },
  };
};
