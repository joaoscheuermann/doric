import {
  AppHooksV1,
  type Disposable,
  DoricGenerationV1,
  HooksV1,
  type Log,
  type Services,
} from 'bundle/contracts';

import type { RuntimeOwner } from '../contracts/runtime.js';
import type { RuntimeLifecycle } from './lifecycle.js';

/*
 * The generation handover (57-WP-H, cross-review G-1), in the runtime's own
 * processes (M3). The runtime runs in every generation process, so a switch
 * or a respawn leaves two runtimes over one storage for a while. Each one
 * hears of every change of the generation set (`onGenerationChangedHook`):
 *
 * - the generation that became active recovers with the processes still
 *   alive, leaving the Projects they own in standby (`recoverWith`);
 * - a generation that is now draining takes a work hold, lets its Projects go
 *   once their running prompts end (`drain`), and signals each one released
 *   to the other generations (`runtime.released`);
 * - the active runtime adopts what it may now take on each release, and each
 *   loss or stop of another generation (`adopt`).
 *
 * The runtime's own signal is recognised by its sender's bundle, because a
 * peer signal reaches every handler of the receiving generation.
 */

const RELEASED = 'runtime.released';
const DRAIN_HOLD = 'runtime.drain';

type Live = {
  readonly generation: number;
  readonly incarnation: number;
  readonly state: 'starting' | 'active' | 'draining' | 'stopped' | 'failed';
};

const same = (
  left: { readonly generation: number; readonly incarnation: number },
  right: { readonly generation: number; readonly incarnation: number },
): boolean =>
  left.generation === right.generation &&
  left.incarnation === right.incarnation;

const owners = (live: readonly Live[]): RuntimeOwner[] =>
  live
    .filter(({ state }) => state === 'active' || state === 'draining')
    .map(({ generation, incarnation }) => ({ generation, incarnation }));

/** Installs the handover hooks; the returned disposable removes them. */
export const installHandover = ({
  services,
  lifecycle,
  log,
}: {
  readonly services: Pick<Services, 'use'>;
  readonly lifecycle: RuntimeLifecycle;
  readonly log: Log;
}): Disposable => {
  const hooks = services.use(HooksV1).use(AppHooksV1);
  /** The runtime processes alive, as the last change reported them. */
  let alive: RuntimeOwner[] = [];
  const registrations: Disposable[] = [];

  /** A failed handover step logs its error with the generation it concerns. */
  const failed =
    (message: string, fields: Record<string, number> = {}) =>
    (error: unknown) => {
      log.error(message, { ...fields, err: error });
    };

  registrations.push(
    hooks.onGenerationChangedHook(async (change, call) => {
      const me = change.live.find((entry) => same(entry, change.self));

      // Not live (it was lost or stopped): nothing to hand over here.
      if (me === undefined) return;

      alive = owners(change.live);

      switch (change.event) {
        case 'activated': {
          if (me.state !== 'active') return;

          // Recovery runs in the background: the change answers at once.
          const others = owners(
            change.live.filter(
              (entry) => entry.state === 'draining' && !same(entry, me),
            ),
          );

          void lifecycle.recoverWith({ live: others }).catch(
            failed('Generation recovery failed', {
              generation: me.generation,
            }),
          );
          return;
        }
        case 'draining': {
          // The change of this generation itself: it lets its Projects go.
          if (!same(change, change.self)) return;

          // The work hold keeps this generation alive until the drain ends;
          // it is taken before this hook answers, so the kernel sees it.
          const held = await services
            .use(DoricGenerationV1)
            .hold({ key: DRAIN_HOLD, label: 'Project handover' }, call);

          void lifecycle
            .drain((projectId) => {
              void services
                .use(DoricGenerationV1)
                .signal({ topic: RELEASED, payload: { projectId } }, call)
                .catch(failed('Project release signal failed'));
            })
            .catch(
              failed('Generation drain failed', {
                generation: change.generation,
              }),
            )
            .finally(() => {
              held.dispose();
            });
          return;
        }
        case 'lost':
        case 'stopped': {
          if (me.state !== 'active') return;

          void lifecycle
            .adopt({ live: alive })
            .catch(failed('Project adoption failed'));
          return;
        }
      }
    }),
  );

  registrations.push(
    hooks.onPeerSignalHook(async (signal) => {
      if (signal.topic !== RELEASED || signal.from.bundleId !== 'runtime') {
        return;
      }

      alive = owners(signal.live);

      const me = signal.live.find((entry) => same(entry, signal.self));

      if (me?.state !== 'active') return;

      await lifecycle
        .adopt({ live: alive })
        .catch(failed('Project adoption failed'));
    }),
  );

  return {
    dispose: () => {
      for (const registration of registrations.splice(0)) {
        registration.dispose();
      }
    },
  };
};
