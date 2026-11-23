// The generation handover over the router (phase 3, slice S46b).

import { fromJson } from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';
import { GenerationService } from 'bundle/contracts/gen/doric/platform/generation/v1/generation_pb.js';
import type { HostContext, LiveGeneration } from 'bundle/host';

import type { RuntimeOwner } from '../../contracts/runtime.js';
import type { RuntimeLifecycle } from '../lifecycle.js';

/** The peer signal a draining runtime sends for each Project it let go. */
const RELEASED = 'runtime.released';
/** The work hold that keeps a draining instance alive until its drain ends. */
const DRAIN_HOLD = 'runtime.drain';

const same = (
  left: { readonly generation: number; readonly incarnation: number },
  right: { readonly generation: number; readonly incarnation: number },
): boolean =>
  left.generation === right.generation &&
  left.incarnation === right.incarnation;

const owners = (live: readonly LiveGeneration[]): RuntimeOwner[] =>
  live.map(({ generation, incarnation }) => ({ generation, incarnation }));

/**
 * Today's handover (`handover.ts`) over the SDK:
 * - `onGenerationChangedHook` becomes `context.generations.onChanged`;
 * - the `runtime.released` peer signal becomes `doric.generation/v1.Signal{topic: 'runtime.released', …}` and
 *   `context.generations.onSignal`, recognised by the sender's bundle as today;
 * - the drain hold becomes `doric.generation/v1.Hold` / `Release`.
 * The decisions (`recoverWith`, `drain`, `adopt`) are today's. Answers the function that removes both handlers.
 */
export const installRoutedHandover = (
  context: Pick<HostContext, 'generations' | 'services' | 'log' | 'instance'>,
  lifecycle: RuntimeLifecycle,
): (() => void) => {
  const generation = () => context.services.use(GenerationService);
  /** The runtime processes alive, as the last change reported them. */
  let alive: RuntimeOwner[] = [];

  /** A failed handover step logs its error with the generation it concerns. */
  const failed =
    (message: string, fields: Record<string, number> = {}) =>
    (error: unknown) => {
      context.log.error(message, { ...fields, err: error });
    };

  const removeChanged = context.generations.onChanged(async (change) => {
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
        void lifecycle
          .recoverWith({ live: others })
          .catch(
            failed('Generation recovery failed', { generation: me.generation }),
          );
        return;
      }
      case 'draining': {
        // The change of this generation itself: it lets its Projects go.
        if (!same(change, change.self)) return;

        // The work hold keeps this instance alive until the drain ends; it is
        // taken before this handler settles, so the router sees it first.
        const { holdId } = await generation().hold({
          key: DRAIN_HOLD,
          label: 'Project handover',
        });

        /** The release signals sent, so the hold outlives them. */
        const signals: Promise<unknown>[] = [];
        void lifecycle
          .drain((projectId) => {
            signals.push(
              generation()
                .signal({
                  topic: RELEASED,
                  payload: fromJson(ValueSchema, { projectId }),
                })
                .catch(failed('Project release signal failed')),
            );
          })
          .catch(
            failed('Generation drain failed', {
              generation: change.generation,
            }),
          )
          .then(() => Promise.all(signals))
          .then(() => generation().release({ holdId }))
          .catch(failed('Generation hold release failed'));
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
  });

  const removeSignal = context.generations.onSignal(async (signal) => {
    if (signal.topic !== RELEASED || signal.from.bundleId !== 'runtime') return;

    alive = owners(signal.live);

    const me = signal.live.find((entry) => same(entry, signal.self));

    if (me?.state !== 'active') return;

    await lifecycle
      .adopt({ live: alive })
      .catch(failed('Project adoption failed'));
  });

  return () => {
    removeChanged();
    removeSignal();
  };
};
