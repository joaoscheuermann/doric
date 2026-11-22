// The drain of an instance (spec `docs/designs/grpc-processes.md`, section
// 6, "Drain"): set `draining`, end its resumable streams, tell it, then wait
// until no call is in flight to or from it and it holds no work hold, or cut
// what is left at the drain deadline. `Router.drain` of `listener.ts`.

import type { Timings } from '../supervisor/timings.js';
import type { CallRelay } from './calls.js';
import {
  type InstanceKey,
  type InstanceTable,
  instanceKey,
} from './instances.js';

/** The two outcomes of {@link Router.drain}. */
export interface Drain {
  /**
   * Resolves once the instance answered `GenerationAck { event:
   * "draining" }`, its stream ended, or `generationAckTimeoutMs`
   * (`control.ts`) passed; never rejects. A hold the instance took in its
   * `draining` handler is held by then (section 6, "Publish", step 3).
   */
  readonly acknowledged: Promise<void>;
  /**
   * Resolves with `idle` when the instance had no call in flight and no
   * hold, `deadline` when the drain deadline cut its calls, `lost` when it
   * was lost, invalid or stopped first; never rejects.
   */
  readonly settled: Promise<'idle' | 'deadline' | 'lost'>;
}

/** What a drain needs of the router. */
export interface DrainEnv {
  readonly instances: InstanceTable;
  readonly relay: CallRelay;
  readonly timings: Timings;
  /** Whether `key` has an accepted control stream. */
  readonly accepted: (key: InstanceKey) => boolean;
  /**
   * Sends `GenerationChanged { event: "draining" }` to `key` alone and
   * resolves on its ack, the stream's end or the ack timeout.
   */
  readonly announceDraining: (key: InstanceKey) => Promise<void>;
}

/** Drains `key` as `Router.drain` says. Never throws. */
export const drainInstance = (
  env: DrainEnv,
  key: InstanceKey,
  held: () => boolean,
): Drain => {
  if (!env.accepted(key)) {
    return {
      acknowledged: Promise.resolve(),
      settled: Promise.resolve('lost'),
    };
  }

  env.instances.setState(key, 'draining');
  env.relay.endResumable(key);

  const acknowledged = env.announceDraining(key);
  const settled = new Promise<'idle' | 'deadline' | 'lost'>((resolve) => {
    let acked = false;
    let done = false;
    const finish = (outcome: 'idle' | 'deadline' | 'lost'): void => {
      if (done) {
        return;
      }

      done = true;
      clearTimeout(timer);
      stopCalls();
      stopStates();
      resolve(outcome);
    };
    const check = (): void => {
      if (acked && env.relay.inFlight(key) === 0 && !held()) {
        finish('idle');
      }
    };
    const timer = setTimeout(() => {
      if (!done) {
        env.relay.cancelDrained(key);
        finish('deadline');
      }
    }, env.timings.drainDeadlineMs);
    const stopCalls = env.relay.onCallEnded((to, from) => {
      if (to === key || from === key) {
        check();
      }
    });
    const stopStates = env.instances.subscribe((record) => {
      if (
        instanceKey(record) === key &&
        (record.state === 'lost' ||
          record.state === 'invalid' ||
          record.state === 'stopped')
      ) {
        finish('lost');
      }
    });

    void acknowledged.then(() => {
      acked = true;
      check();
    });
  });

  return { acknowledged, settled };
};
