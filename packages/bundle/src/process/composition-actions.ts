// The host's recovery members of `doric.catalog/v1` (HR-6): "Disable a
// bundle" and "Return to default composition" from the desktop splash. Each
// persists the composition overrides, then publishes a new generation, whose
// catalog read applies them; a change the running kernel cannot take (its
// partition changed) is kept and applies at the next boot.

import { ContractError } from '../contracts/error.js';
import type { PlatformLog } from '../loader/log.js';
import {
  clearCompositionOverrides,
  readCompositionOverrides,
  writeCompositionOverrides,
} from '../loader/overrides.js';
import type { Composition } from '../runtime/composition.js';
import type { CatalogCompositionProvider } from '../runtime/platform-providers.js';
import type { PublishResult } from './manager.js';

export interface CompositionActionsOptions {
  /** The overrides file the host's catalog reads apply. */
  readonly path: string;
  /** The composition as written, without overrides. */
  readonly composition: () => Promise<Composition>;
  readonly publish: () => Promise<PublishResult>;
  readonly log: PlatformLog;
}

export const createCompositionActions = (
  options: CompositionActionsOptions,
): CatalogCompositionProvider => {
  const { path, log } = options;
  // One change at a time: each reads the overrides the previous one wrote.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    const next = queue.then(run, run);

    queue = next.catch(() => undefined);

    return next;
  };

  const publish = async (): Promise<void> => {
    const result = await options.publish();

    if (result.status === 'published') {
      log.info(
        { generation: result.generation, path },
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
        const composition = await options.composition();

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
