// The desktop resolution of one host distribution (section 11.5 step 4):
// desktopMain and client are resolved from the same candidates; host-side
// quarantines carry over [S8-8], artifacts that failed verification
// quarantine their bundle with `invalid_part`, and the resolver adds the
// desktop's own reasons (engines.doric against this platform).

import type { QuarantineReason } from 'bundle/contracts';
import {
  type CatalogCandidate,
  candidatesFromDistribution,
  compositionFromDistribution,
  type DistributionBundle,
  type DistributionCatalog,
  PLATFORM_VERSION,
  type ResolvedEnvironment,
  resolveEnvironment,
} from 'bundle/runtime';

import type { ArtifactFailure } from './artifacts';

export interface DesktopQuarantine {
  readonly id: string;
  readonly version: string;
  readonly reasons: readonly QuarantineReason[];
}

export interface DesktopResolution {
  readonly generation: number;
  readonly desktopMain: ResolvedEnvironment;
  readonly client: ResolvedEnvironment;
  /**
   * Bundles with a desktop part that the desktop quarantined although the
   * host did not: reported to the host diagnostics and shown by the splash.
   */
  readonly quarantines: readonly DesktopQuarantine[];
}

export interface ResolveOptions {
  readonly platformVersion?: string;
  /**
   * Last-good-core mode: only these bundle IDs are candidates and the
   * composition enables only them (the core plus the foundation).
   */
  readonly only?: { readonly core: string; readonly ids: ReadonlySet<string> };
}

const hasDesktopPart = (bundle: DistributionBundle): boolean =>
  bundle.parts.desktopMain !== undefined || bundle.parts.client !== undefined;

export const resolveDistribution = (
  catalog: DistributionCatalog,
  generation: number,
  failures: readonly ArtifactFailure[] = [],
  options: ResolveOptions = {},
): DesktopResolution => {
  const failed = new Map<string, QuarantineReason[]>();

  for (const failure of failures) {
    const reasons = failed.get(failure.bundleId) ?? [];

    reasons.push({ code: 'invalid_part', message: failure.message });
    failed.set(failure.bundleId, reasons);
  }

  const only = options.only;
  const candidates: CatalogCandidate[] = candidatesFromDistribution(catalog)
    .filter((candidate) => only === undefined || only.ids.has(candidate.id))
    .map((candidate) => {
      const extra = failed.get(candidate.id);

      return extra === undefined
        ? candidate
        : { ...candidate, errors: [...candidate.errors, ...extra] };
    });
  const base = compositionFromDistribution(catalog);
  const composition =
    only === undefined
      ? base
      : {
          core: only.core,
          enabled: base.enabled.filter((id) => only.ids.has(id)),
          providers: Object.fromEntries(
            Object.entries(base.providers).filter(([, id]) => only.ids.has(id)),
          ),
        };
  const input = {
    candidates,
    composition,
    platformVersion: options.platformVersion ?? PLATFORM_VERSION,
    generation,
  };
  const desktopMain = resolveEnvironment(input, 'desktopMain');
  const client = resolveEnvironment(input, 'client');
  const hostState = new Map(
    catalog.bundles.map((bundle) => [bundle.id, bundle]),
  );
  const quarantines: DesktopQuarantine[] = [];

  for (const environment of [desktopMain, client]) {
    for (const entry of environment.entries) {
      const host = hostState.get(entry.id);

      if (
        entry.state !== 'quarantined' ||
        host === undefined ||
        host.state === 'quarantined' ||
        !hasDesktopPart(host) ||
        quarantines.some((known) => known.id === entry.id)
      ) {
        continue;
      }

      quarantines.push({
        id: entry.id,
        version: entry.version,
        reasons: [...entry.reasons],
      });
    }
  }

  return { generation, desktopMain, client, quarantines };
};

/** The foundation bundles of a distribution (host snapshot phase). */
export const foundationIds = (catalog: DistributionCatalog): string[] =>
  catalog.host.bundles
    .filter((bundle) => bundle.phase === 'foundation')
    .map((bundle) => bundle.id);
