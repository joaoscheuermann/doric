// The platform's recovery members of `doric.catalog/v1` (HR-6): "Disable a
// bundle" and "Return to default composition" from the desktop splash. Each
// writes the composition overrides, then publishes the host's next
// resolution, whose catalog read applies them; a change the running host
// cannot take (its core changed) is kept and applies at the next boot. The
// kernel's `process/composition-actions.ts` stays until S67 deletes it.

import { ContractError } from '../contracts/error.js';
import {
  clearCompositionOverrides,
  readCompositionOverrides,
  writeCompositionOverrides,
} from '../loader/overrides.js';
import type { PlatformLog } from '../runtime/activation.js';
import type { ResolvedEnvironment } from '../runtime/catalog.js';
import type { Composition } from '../runtime/composition.js';
import type { CatalogCompositionProvider } from '../runtime/platform-providers.js';
import type { PublishResult } from './supervisor/publish.js';

/** How the platform changes the host's composition (HR-6). */
export interface PlatformCompositionOptions {
  /**
   * The overrides file the host's catalog read applies
   * (`compositionOverridesPath` of the host's composition).
   */
  readonly overridesPath: string;
  /** The composition as written, without overrides. */
  readonly read: () => Promise<Composition>;
  /**
   * The host's next resolution, read after the overrides changed, with
   * the overrides applied and the generation `generation`. Rejects when it
   * cannot be read; the action then fails with that error.
   */
  readonly resolve: (generation: number) => Promise<ResolvedEnvironment>;
}

/**
 * The recovery members of `doric.catalog/v1` on the platform, one change at
 * a time in call order (each reads the overrides the previous wrote):
 *
 * - `disable({ bundleId })`: `not_found` when `read()`'s `enabled` lacks it;
 *   `invalid_input` when it is the composition's core; otherwise adds it to
 *   the overrides' `disabled` (an unreadable file is replaced, logged
 *   `Composition overrides replaced`), logs `Bundle disabled`
 *   `{bundleId, path}`, then publishes;
 * - `resetComposition()`: clears the overrides, logs `Composition reset`
 *   `{path}`, then publishes.
 *
 * Publishing is `publish(await resolve(current().generation + 1))`. A
 * `published` result logs `Composition published` `{generation, bundles,
 * path}` and the call answers once the publish settled; any other result
 * logs `Composition change applies at the next host start`
 * `{status, reason, path}` and fails with `unavailable`, message the
 * result's reason, details `{ status }`. The overrides stay written either
 * way, so the next boot applies them. Messages are the kernel's
 * (`process/composition-actions.ts`).
 */
export const createPlatformCompositionActions = (
  options: PlatformCompositionOptions,
  platform: {
    readonly current: () => ResolvedEnvironment;
    readonly publish: (next: ResolvedEnvironment) => Promise<PublishResult>;
    readonly log: PlatformLog;
  },
): CatalogCompositionProvider => {
  const { overridesPath: path } = options;
  const { log } = platform;
  // One change at a time: each reads the overrides the previous one wrote.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    const next = queue.then(run, run);

    queue = next.catch(() => undefined);

    return next;
  };

  const publish = async (): Promise<void> => {
    const next = await options.resolve(platform.current().generation + 1);
    const result = await platform.publish(next);

    if (result.status === 'published') {
      log.info(
        { generation: next.generation, bundles: result.bundles, path },
        'Composition published',
      );

      return;
    }

    log.warn(
      { status: result.status, reason: result.reason, path },
      'Composition change applies at the next host start',
    );
    throw new ContractError('unavailable', result.reason, {
      status: result.status,
    });
  };

  return {
    disable: ({ bundleId }) =>
      serial(async () => {
        const composition = await options.read();

        if (!composition.enabled.includes(bundleId)) {
          throw new ContractError(
            'not_found',
            `Bundle ${bundleId} is not in the composition.`,
          );
        }

        // Without its core the host cannot start, and so cannot be asked to
        // return to the default composition.
        if (bundleId === composition.core) {
          throw new ContractError(
            'invalid_input',
            `Bundle ${bundleId} is the core of the composition.`,
          );
        }

        let disabled: readonly string[] = [];

        try {
          disabled = (await readCompositionOverrides(path))?.disabled ?? [];
        } catch (error) {
          // An unreadable file is replaced; the catalog already ignored it.
          log.warn(
            { path, error: error instanceof Error ? error.message : error },
            'Composition overrides replaced',
          );
        }

        await writeCompositionOverrides(path, {
          disabled: [...new Set([...disabled, bundleId])],
        });
        log.info({ bundleId, path }, 'Bundle disabled');
        await publish();
      }),
    resetComposition: () =>
      serial(async () => {
        await clearCompositionOverrides(path);
        log.info({ path }, 'Composition reset');
        await publish();
      }),
  };
};
