// The publish of a host (spec `docs/designs/grpc-processes.md`, section 6,
// "Generations and drain"): compares the next resolution with the running
// one bundle by bundle, answers `kernel_restart_required` when `core`
// changed (A48, D32), and otherwise moves each changed bundle to a new
// generation in activation order.

import type { ResolvedEnvironment } from '../../runtime/catalog.js';

/**
 * The answer of a publish (section 6, "Publish"):
 *
 * - `published`: every changed bundle runs its new generation, or was
 *   drained without a successor, or started; `bundles` lists the changed
 *   bundles in the order they were handled, empty when nothing changed;
 * - `failed`: the new generation of each bundle in `bundles` did not become
 *   `active` after its restarts, so its previous generation stays active
 *   (`generation_failed` in the diagnostics); every other changed bundle
 *   was handled as for `published`. `reason` names the failed bundles;
 * - `kernel_restart_required`: `core` changed, and no bundle was changed.
 */
export type PublishResult =
  | { readonly status: 'published'; readonly bundles: readonly string[] }
  | {
      readonly status: 'failed';
      readonly reason: string;
      readonly bundles: readonly string[];
    }
  | { readonly status: 'kernel_restart_required'; readonly reason: string };

/** The bundle that has one generation (A48, D32). */
export const kernelBundleId = 'core';

/** The `reason` of `kernel_restart_required` (section 6). */
export const kernelRestartReason = 'The core changed; restart the host.';

/**
 * A bundle's running generation as the supervisor tracks it: set when the
 * generation is spawned at the boot or by a publish, kept across its
 * incarnations (a crash restarts the same generation), dropped when the
 * bundle is quarantined or drained without a successor.
 */
export interface BundleGeneration {
  readonly bundleId: string;
  /** 1 at the boot; one more at each publish that changed the bundle. */
  readonly generation: number;
  /**
   * `signatureOf` the resolution and the executable's digest the
   * generation was spawned with.
   */
  readonly signature: string;
}

/**
 * What a publish compares of a bundle (section 6, "Publish"): its id,
 * version, source and state, the contracts it provides in `resolved` (the
 * contract ids and versions of `resolved.contracts` that list it among their
 * providers), and `digest`, the SHA-256 of its executable. Two signatures
 * are equal exactly when all of these are; the order of `resolved`'s
 * entries and contracts does not matter. `undefined` for a bundle that has
 * no entry in `resolved`. Pure; never throws.
 */
export const signatureOf = (
  resolved: ResolvedEnvironment,
  bundleId: string,
  digest: string,
): string | undefined => {
  const entry = resolved.entries.find(({ id }) => id === bundleId);

  if (entry === undefined) {
    return undefined;
  }

  const provides = resolved.contracts
    .flatMap(({ id, providers }) =>
      providers
        .filter((provider) => provider.bundleId === bundleId)
        .map((provider) => `${id}@${provider.version}`),
    )
    .sort();

  return JSON.stringify([
    entry.id,
    entry.version,
    entry.source,
    entry.state,
    provides,
    digest,
  ]);
};

/** Whether `next` schedules `bundleId`. */
const schedules = (next: ResolvedEnvironment, bundleId: string): boolean =>
  next.entries.some(
    ({ id, state }) => id === bundleId && state === 'scheduled',
  );

/**
 * The bundles a publish handles, in this order: the bundles `next`
 * schedules, in the order of `next.order`, whose `signatureOf(next, id,
 * digestOf(id))` differs from their running generation's signature, or that
 * have no running generation; then the bundles with a running generation
 * that `next` does not schedule (it disables or quarantines them, or lists
 * them in no entry): those of `spawned` first, in its order, then those of
 * `next.entries`, in theirs. `spawned` names the bundles with a running
 * generation in the order they were spawned
 * ({@link PublishTarget.runningBundles}); without it a bundle that `next`
 * lists in no entry is not found. A bundle without a running generation
 * that `next` does not schedule is not listed. Calls `digestOf` once per
 * bundle of `next.order`. Pure apart from `digestOf`; a throw of `digestOf`
 * propagates.
 */
export const changedBundles = (
  running: (bundleId: string) => BundleGeneration | undefined,
  next: ResolvedEnvironment,
  digestOf: (bundleId: string) => string,
  spawned: readonly string[] = [],
): readonly string[] => {
  const changed = next.order.filter((id) => {
    const digest = digestOf(id);

    return (
      schedules(next, id) &&
      running(id)?.signature !== signatureOf(next, id, digest)
    );
  });
  const unscheduled = [
    ...new Set([...spawned, ...next.entries.map(({ id }) => id)]),
  ].filter((id) => !schedules(next, id) && running(id) !== undefined);

  return [...changed, ...unscheduled];
};

/** What `publish` needs of the supervisor; the supervisor is one. */
export interface PublishTarget {
  /** The bundle's running generation; `undefined` when it has none. */
  generationOf(bundleId: string): BundleGeneration | undefined;
  /**
   * Makes `next` the resolution the supervisor and the router use from now
   * on: entries, activation order and dependencies for later spawns and
   * restarts, and `callRoutesOf(next)` for later calls (`Router.setRoutes`).
   * Starts and stops nothing. Never throws.
   */
  adopt(next: ResolvedEnvironment): void;
  /**
   * Moves a bundle that `next` schedules to a new generation (section 6,
   * "Publish", steps 1 to 3): spawns generation N+1 (for a bundle with no
   * running generation, one above the newest it ever spawned of it, so 1
   * for a new bundle; a quarantined bundle is unquarantined and started
   * again) with `digest` recorded in its signature, and
   * activates it once every bundle in its `dependencies` is `active`, with
   * the restarts of section 7. On success: the new instance is `active` and
   * takes new calls; the previous one, if any, is drained
   * (`Router.drain`) and this resolves after its `draining` ack and after
   * `Router.announce('activated', …)` resolved, with `active`; the rest of
   * the drain, `Stop` and `announce('stopped', …)` run on afterwards. When
   * the new generation does not become active (its restarts exhausted, or
   * its activation failed): records `generation_failed` for the bundle,
   * leaves the previous generation active and the bundle unquarantined, and
   * resolves with `failed`. Never rejects.
   */
  replace(bundleId: string, digest: string): Promise<'active' | 'failed'>;
  /**
   * Drains a bundle's running generation with no successor (section 6,
   * "Publish", step 4: `next` disables or quarantines it, or no longer
   * lists it) and drops it from the running generations. Resolves after the
   * `draining` ack; the rest of the drain, `Stop` and `announce('stopped',
   * …)` run on afterwards. A bundle with no running generation resolves at
   * once. Never rejects.
   */
  retire(bundleId: string): Promise<void>;
  /**
   * The bundles with a running generation, in the order they were spawned:
   * how `publish` finds the running bundles that `next` lists in no entry,
   * to retire them. Without it such a bundle keeps running.
   */
  runningBundles?(): readonly string[];
}

/**
 * Publishes `next` (section 6, "Publish") on `target`:
 *
 * - when `core` has a running generation and `signatureOf(next, 'core',
 *   digestOf('core'))` differs from its signature (`core` changed, was
 *   disabled, quarantined or removed), answers `kernel_restart_required`
 *   with {@link kernelRestartReason}, and calls neither `adopt`, `replace`
 *   nor `retire`;
 * - otherwise `adopt(next)`, then for each bundle of {@link changedBundles}
 *   (with `target.runningBundles()` as its `spawned`), one after the other:
 *   `replace` when `next` schedules it, `retire` otherwise; and answers
 *   `published` with those bundles, or `failed` with the ones whose
 *   `replace` answered `failed` once every bundle was handled.
 *
 * `digestOf` answers a bundle's executable digest as it is now on disk;
 * it is read once per bundle of `next.order`. Not serialized: the caller
 * (`Platform.publish`) runs one publish at a time. Rejects only when
 * `digestOf` throws, before anything changed.
 */
export const publish = async (
  target: PublishTarget,
  next: ResolvedEnvironment,
  digestOf: (bundleId: string) => string,
): Promise<PublishResult> => {
  const digests = new Map<string, string>();
  const digest = (bundleId: string): string => {
    const known = digests.get(bundleId);

    if (known !== undefined) {
      return known;
    }

    const read = digestOf(bundleId);

    digests.set(bundleId, read);

    return read;
  };
  const changed = changedBundles(
    (bundleId) => target.generationOf(bundleId),
    next,
    digest,
    target.runningBundles?.() ?? [],
  );
  const kernel = target.generationOf(kernelBundleId);

  if (
    kernel !== undefined &&
    signatureOf(next, kernelBundleId, digest(kernelBundleId)) !==
      kernel.signature
  ) {
    return { status: 'kernel_restart_required', reason: kernelRestartReason };
  }

  target.adopt(next);

  const failed: string[] = [];

  for (const bundleId of changed) {
    if (!schedules(next, bundleId)) {
      await target.retire(bundleId);
    } else if (
      (await target.replace(bundleId, digest(bundleId))) === 'failed'
    ) {
      failed.push(bundleId);
    }
  }

  return failed.length === 0
    ? { status: 'published', bundles: changed }
    : {
        status: 'failed',
        reason: `The new generation of ${failed.join(', ')} did not become active.`,
        bundles: failed,
      };
};
