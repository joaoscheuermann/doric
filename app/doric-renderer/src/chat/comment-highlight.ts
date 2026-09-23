/**
 * The one name every commented excerpt is painted under. The shell styles it
 * with `::highlight(comment)` in `index.html`, and a Custom Highlight name
 * matches its pseudo-element exactly or nothing paints.
 */
export const commentHighlightName = 'comment';

/** The Custom Highlight registry, narrowed to the two operations this module uses. */
export type HighlightRegistry = {
  set(name: string, highlight: Highlight): void;
  delete(name: string): void;
};

/** The one place `CSS.highlights` is read, and the one guard against its absence. */
const highlightRegistry = (): HighlightRegistry | undefined => {
  const registry: unknown = CSS.highlights;
  if (typeof registry !== 'object' || registry === null) return undefined;
  const candidate = registry as Partial<HighlightRegistry>;
  return typeof candidate.set === 'function' &&
    typeof candidate.delete === 'function'
    ? (candidate as HighlightRegistry)
    : undefined;
};

/** Publishes the merged ranges under the one name the shell styles. */
const publishHighlight = (
  registry: HighlightRegistry,
  ranges: readonly Range[],
): void => {
  // No ranges means no commented excerpt is mounted, so the name goes away
  // rather than holding an empty highlight.
  if (ranges.length === 0) registry.delete(commentHighlightName);
  else registry.set(commentHighlightName, new Highlight(...ranges));
};

/**
 * Ranges published under separate keys, merged into the one list `publish`
 * receives. A key identifies the owner of the ranges and is only ever compared,
 * so any stable identity works.
 */
export type KeyedRanges<K, R> = {
  /** Replaces the ranges `key` contributes and publishes the merged list. */
  set(key: K, ranges: readonly R[]): void;
  /** Drops the ranges `key` contributed and publishes the merged list. */
  clear(key: K): void;
  /** The ranges every registered key currently contributes. */
  current(): readonly R[];
};

/**
 * Aggregates ranges published under separate keys into one list. The Custom
 * Highlight API is global and one name holds one `Highlight`, so the ranges of
 * every mounted document have to be merged before they are published: a name
 * per document would let the last one to register clobber the others.
 */
export const keyedRanges = <K, R>(
  publish: (ranges: readonly R[]) => void,
): KeyedRanges<K, R> => {
  const contributions = new Map<K, readonly R[]>();
  const current = (): readonly R[] => [...contributions.values()].flat();
  return {
    set: (key, ranges) => {
      contributions.set(key, ranges);
      publish(current());
    },
    clear: (key) => {
      if (!contributions.delete(key)) return;
      publish(current());
    },
    current,
  };
};

/**
 * The ranges of every mounted document, merged and published into `registry`
 * under the one styled name. Keys identify a document and are only ever
 * compared, so the caller's editor instance serves as one.
 */
export const commentHighlightsIn = (
  registry: HighlightRegistry,
): KeyedRanges<object, Range> =>
  keyedRanges<object, Range>((ranges) => publishHighlight(registry, ranges));

/**
 * The registry every mounted document publishes into. It is shared because
 * `CSS.highlights` is global and one name holds one `Highlight`: one registry
 * holds the ranges of every document and republishes the merge. Absent when the
 * runtime has no Custom Highlight API, which leaves the caller nothing to
 * publish into.
 */
let shared: KeyedRanges<object, Range> | undefined;

export const commentHighlights = (): KeyedRanges<object, Range> | undefined => {
  const registry = highlightRegistry();
  return registry === undefined
    ? undefined
    : (shared ??= commentHighlightsIn(registry));
};
