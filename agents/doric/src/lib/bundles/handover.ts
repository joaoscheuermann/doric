import type { GenerationManager } from 'bundle';
import type { Services } from 'bundle/contracts';
import { type RuntimeOwner, RuntimeV1 } from 'runtime/contracts';

/*
 * The kernel side of the generation handover (57-WP-H, cross-review G-1).
 * The runtime runs in every generation process, so a switch or a respawn
 * leaves two runtimes over one storage for a while. The kernel tells each one
 * its part:
 *
 * - the generation that became active recovers with the processes still
 *   alive, leaving the Projects they own in standby (`recoverWith`);
 * - a generation that is now draining lets its Projects go once their running
 *   prompts end (`drain`), started from the activation listener so that call
 *   keeps the draining generation alive;
 * - each Project it lets go, and each draining generation that dies, makes the
 *   active runtime adopt what it may now take (`adopt`).
 *
 * Boot is not handled here: the kernel's boot sequence calls `recover()`.
 */

export interface HandoverOptions {
  readonly generations: Pick<
    GenerationManager,
    'onActive' | 'onLost' | 'describe'
  >;
  /** The kernel's services pinned to generation N (`platform.view`). */
  readonly view: (generation: number) => Services;
  /** The kernel's services: they resolve the active generation. */
  readonly services: Services;
  readonly log: {
    error(fields: Readonly<Record<string, unknown>>, message: string): void;
  };
}

const keyOf = ({ generation, incarnation }: RuntimeOwner) =>
  `${generation}:${incarnation}`;

/** Installs the handover listeners; the returned function removes them. */
export const installHandover = ({
  generations,
  view,
  services,
  log,
}: HandoverOptions): (() => void) => {
  const drains = new Set<string>();
  /** The runtime processes still alive, except `excluded`. */
  const alive = (excluded?: RuntimeOwner): RuntimeOwner[] =>
    generations
      .describe()
      .filter(
        (summary) =>
          (summary.state === 'active' || summary.state === 'draining') &&
          (excluded === undefined || keyOf(summary) !== keyOf(excluded)),
      )
      .map(({ generation, incarnation }) => ({ generation, incarnation }));
  const adopt = (excluded?: RuntimeOwner) => {
    services
      .use(RuntimeV1)
      .adopt({ live: alive(excluded) })
      .catch((error: unknown) => {
        log.error({ err: error }, 'Project adoption failed');
      });
  };
  const offActive = generations.onActive((generation) => {
    const summaries = generations.describe();
    const active = summaries.find(
      (summary) =>
        summary.generation === generation && summary.state === 'active',
    );

    // A failed generation activates an empty view: no runtime runs there.
    if (active === undefined) return;

    const others = summaries.filter(
      (summary) =>
        summary.generation !== generation && summary.state === 'draining',
    );

    // Synchronously, before the platform checks whether they can stop.
    for (const summary of others) {
      const key = keyOf(summary);

      if (drains.has(key)) continue;
      drains.add(key);

      try {
        view(summary.generation)
          .use(RuntimeV1)
          .drain(() => adopt())
          .catch((error: unknown) => {
            log.error(
              { err: error, generation: summary.generation },
              'Generation drain failed',
            );
          })
          .finally(() => {
            drains.delete(key);
            // Whatever it still held is released or lost by now.
            adopt();
          });
      } catch (error) {
        drains.delete(key);
        log.error(
          { err: error, generation: summary.generation },
          'Generation drain failed',
        );
      }
    }

    view(generation)
      .use(RuntimeV1)
      .recoverWith({
        live: others.map(({ generation: number, incarnation }) => ({
          generation: number,
          incarnation,
        })),
      })
      .catch((error: unknown) => {
        log.error({ err: error, generation }, 'Generation recovery failed');
      });
  });
  const offLost = generations.onLost((lost) => {
    const summary = generations
      .describe()
      .find(
        (entry) =>
          entry.generation === lost.generation &&
          entry.incarnation === lost.incarnation,
      );

    // A lost active generation respawns, and its successor recovers then.
    if (summary?.state !== 'draining') return;
    adopt({ generation: lost.generation, incarnation: lost.incarnation });
  });

  return () => {
    offActive();
    offLost();
  };
};
