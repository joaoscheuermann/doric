import type { CatalogBundle, CatalogSnapshot } from 'bundle/contracts';
import { type ErrorCatalog, type ErrorInfo, errorFrom } from 'desktop/reads';

/**
 * What the window's quarantine notice hands to `ErrorNotice` (§7.2): plain
 * data, built only from the bundle catalog snapshot.
 *
 * - `error`: code `bundle_quarantined`, message `Turned off: <ids>.` (the
 *   quarantined bundle ids joined by `, `, in the snapshot's order), no
 *   causes (the bundles are separate failures, not a chain) and no `at` (the
 *   snapshot does not say when a bundle was quarantined).
 * - `catalog`: exactly one entry, `bundle_quarantined`, titled
 *   `1 extension couldn't start` or `<n> extensions couldn't start`, with
 *   `retryable: false` and `tone: 'warning'`. `layoutErrorCatalog` is not
 *   merged in: the notice shows no other code.
 * - `context`: one entry per quarantined bundle, in the snapshot's order,
 *   keyed `<id>@<version>`; the value is each reason's message, followed by
 *   ` (<contract>)` when the reason names one, joined by `; `, or
 *   `no reason given` when the bundle lists no reason.
 */
export interface QuarantineNotice {
  readonly error: ErrorInfo;
  readonly catalog: ErrorCatalog;
  readonly context: Readonly<Record<string, string>>;
}

/** One bundle's reasons, as its context line reads them. */
const reasonsOf = ({ reasons }: CatalogBundle): string =>
  reasons.length === 0
    ? 'no reason given'
    : reasons
        .map(({ message, contract }) =>
          contract === undefined ? message : `${message} (${contract})`,
        )
        .join('; ');

/**
 * One notice for every bundle `snapshot.bundles` lists with state
 * `quarantined`, in the snapshot's order; `undefined` when it lists none.
 * Bundles in any other state (`disabled` included) are not listed.
 *
 * Pure: the same snapshot gives an equal value, the snapshot is not
 * mutated, and the result is plain JSON. Never throws for a snapshot that
 * satisfies `CatalogSnapshot`.
 */
export const quarantineNotice = (
  snapshot: CatalogSnapshot,
): QuarantineNotice | undefined => {
  const quarantined = snapshot.bundles.filter(
    ({ state }) => state === 'quarantined',
  );
  if (quarantined.length === 0) return undefined;
  const count = quarantined.length;
  return {
    error: errorFrom(
      'bundle_quarantined',
      `Turned off: ${quarantined.map(({ id }) => id).join(', ')}.`,
      undefined,
      { at: null },
    ),
    catalog: {
      bundle_quarantined: {
        title: `${count} ${count === 1 ? 'extension' : 'extensions'} couldn't start`,
        retryable: false,
        tone: 'warning',
      },
    },
    context: Object.fromEntries(
      quarantined.map((bundle) => [
        `${bundle.id}@${bundle.version}`,
        reasonsOf(bundle),
      ]),
    ),
  };
};
