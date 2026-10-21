// Where a comment's quoted words stand in the text a block draws, stated in
// terms of its arguments. The transcript keeps every passage that holds a
// comment highlighted, so the quote a seat holds is found again, each time the
// answer is drawn, among the text runs of the block the selection started in
// and the blocks after it.
//
// The quote is the selection's own text, which joins blocks with line breaks a
// drawn block does not hold as text, and a drawn run may break a line the quote
// reads as a space; so the match ignores whitespace on both sides. A passage
// can occur more than once, and the seat remembers how far into its block the
// selection started (`solidLength`), so the occurrence nearest that point wins.

/** One point among the text runs: the run's index and an offset into it. */
export interface QuotePoint {
  readonly segment: number;
  readonly offset: number;
}

/** Where a quote starts and where it ends (exclusive), among the runs. */
export interface QuoteSpan {
  readonly start: QuotePoint;
  readonly end: QuotePoint;
}

const WHITESPACE = /\s/;

/** The characters of `text` that are not whitespace. */
const solid = (text: string): string => text.replace(/\s+/g, '');

/** How many characters of `text` are not whitespace. */
export const solidLength = (text: string): number => solid(text).length;

/**
 * Finds `quote` among the text runs a block draws, ignoring whitespace: the
 * occurrence whose start is nearest `near` — counted in characters that are not
 * whitespace — else `undefined` when the runs no longer hold the words.
 */
export const locateQuote = (
  segments: readonly string[],
  quote: string,
  near = 0,
): QuoteSpan | undefined => {
  const needle = solid(quote);
  if (needle.length === 0) return undefined;

  const points: QuotePoint[] = [];
  let haystack = '';
  segments.forEach((text, segment) => {
    for (let offset = 0; offset < text.length; offset += 1) {
      const character = text.charAt(offset);
      if (WHITESPACE.test(character)) continue;
      haystack += character;
      points.push({ segment, offset });
    }
  });

  let best: number | undefined;
  for (
    let at = haystack.indexOf(needle);
    at >= 0;
    at = haystack.indexOf(needle, at + 1)
  ) {
    if (best === undefined || Math.abs(at - near) < Math.abs(best - near)) {
      best = at;
    }
  }
  if (best === undefined) return undefined;

  const first = points[best] as QuotePoint;
  const last = points[best + needle.length - 1] as QuotePoint;

  return {
    start: first,
    end: { segment: last.segment, offset: last.offset + 1 },
  };
};
