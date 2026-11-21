// The marks the Files tree draws (bundle isolation 9): every provider of
// `files.decorations/v1` answers its own marks, and the tree draws their
// merge. For a path two providers mark, the provider whose bundle id is
// smaller (by code unit) wins; the error shown is the first in bundle-id
// order; the tree refreshes while any provider fetches.

import type {
  DecorationsObservation,
  FileMark,
} from '../../contracts/index.js';

/** One provider's latest answer, under the bundle id that provides it. */
export interface ProviderMarks {
  readonly bundleId: string;
  readonly observation: DecorationsObservation;
}

/** What the tree draws from every provider's answer. */
export interface MergedDecorations {
  readonly marks: ReadonlyMap<string, FileMark>;
  readonly error?: string;
  readonly fetching: boolean;
}

type MarkList = DecorationsObservation['marks'];

/** The mark lists each merge was made from, by bundle id. */
const sources = new WeakMap<MergedDecorations, ReadonlyMap<string, MarkList>>();

const byBundleId = (left: ProviderMarks, right: ProviderMarks): number =>
  left.bundleId < right.bundleId ? -1 : left.bundleId > right.bundleId ? 1 : 0;

const sameLists = (
  before: ReadonlyMap<string, MarkList> | undefined,
  lists: ReadonlyMap<string, MarkList>,
): boolean =>
  before !== undefined &&
  before.size === lists.size &&
  [...lists].every(([bundleId, marks]) => before.get(bundleId) === marks);

/**
 * Merges the providers' answers. When no provider's mark list changed since
 * `previous`, its marks are kept, and `previous` itself is given back when
 * its error and fetching are unchanged too, so the rows keep their identity.
 */
export const mergeDecorations = (
  answers: readonly ProviderMarks[],
  previous?: MergedDecorations,
): MergedDecorations => {
  const ordered = [...answers].sort(byBundleId);
  const lists = new Map(
    ordered.map(({ bundleId, observation }) => [bundleId, observation.marks]),
  );
  const error = ordered.find(
    ({ observation }) => observation.error !== undefined,
  )?.observation.error;
  const fetching = ordered.some(({ observation }) => observation.fetching);
  const kept =
    previous !== undefined && sameLists(sources.get(previous), lists)
      ? previous
      : undefined;
  if (kept !== undefined && kept.error === error && kept.fetching === fetching)
    return kept;
  const merged: MergedDecorations = {
    // Written from the largest bundle id down, so the smallest one's mark stays.
    marks:
      kept?.marks ??
      new Map(
        [...ordered]
          .reverse()
          .flatMap(({ observation }) =>
            observation.marks.map(({ path, mark }) => [path, mark] as const),
          ),
      ),
    ...(error === undefined ? {} : { error }),
    fetching,
  };
  sources.set(merged, lists);
  return merged;
};
