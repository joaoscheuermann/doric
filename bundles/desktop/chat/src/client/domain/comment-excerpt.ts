// The context a comment line shows above its note, stated in terms of its
// arguments: the passage the comment is about, read in the paragraph it was
// selected from — the words before it, the quoted words, and the words after
// it — on one line the card truncates. The paragraph is the transcript's own
// text of the block the anchor names (`turn`, `block`); when the transcript no
// longer holds it, or the words are not found there, the quote stands alone. A
// target whose anchor quotes nothing (an element, a point, a file line) shows
// its anchor label, with nothing highlighted.

import { locateQuote } from './comment-highlight.js';
import { anchorLabel, anchorOf, isIndex } from './composer-stack.js';

/**
 * One line of context: `quote` is the highlighted passage, empty for a target
 * whose anchor quotes nothing (its label is then `before`).
 */
export interface Excerpt {
  readonly before: string;
  readonly quote: string;
  readonly after: string;
}

/**
 * How much of the paragraph before the quote the line keeps: enough to read
 * the passage in its sentence, while a quote late in a long paragraph still
 * shows before the card's ellipsis.
 */
export const EXCERPT_LEAD = 48;

const collapse = (text: string): string => text.replace(/\s+/g, ' ');

/** The words before the quote, cut to the lead at a word boundary. */
const lead = (text: string): string => {
  const words = collapse(text).trimStart();
  if (words.length <= EXCERPT_LEAD) return words;
  const tail = words.slice(-EXCERPT_LEAD);
  const space = tail.indexOf(' ');
  return `…${space < 0 || space === tail.length - 1 ? tail : tail.slice(space + 1)}`;
};

/**
 * Where a comment's anchor stands in the transcript: its turn and block, and
 * the item of that block its words start in when the block is a list.
 */
export interface AnchorBlock {
  readonly turn: string;
  readonly block: number;
  readonly item?: number;
}

/**
 * The turn and block a target's anchor names, when it names both, with the
 * list item it names in that block.
 */
export const anchorBlock = (target: unknown): AnchorBlock | undefined => {
  const anchor = anchorOf(target) as
    | {
        readonly turn?: unknown;
        readonly block?: unknown;
        readonly item?: unknown;
      }
    | undefined;
  const turn = anchor?.turn;
  const block = anchor?.block;
  if (typeof turn !== 'string' || turn.length === 0 || !isIndex(block))
    return undefined;
  return isIndex(anchor?.item)
    ? { turn, block, item: anchor.item }
    : { turn, block };
};

/** Where in its block the anchor's words start, when the anchor records it. */
const anchorAt = (target: unknown): number | undefined => {
  const at = (anchorOf(target) as { readonly at?: unknown } | undefined)?.at;
  return isIndex(at) ? at : undefined;
};

/**
 * The excerpt a comment line shows for `target`: the quote read in
 * `paragraph` (the occurrence nearest `at` — given, else the anchor's own
 * `at`, else the first — counted in the characters that are not whitespace
 * before the selection's start), the quote alone when the
 * paragraph is unknown or no longer holds it, else the anchor's label — and
 * `undefined` for a target with no anchor to show.
 */
export const commentExcerpt = (
  target: unknown,
  paragraph?: string,
  at?: number,
): Excerpt | undefined => {
  const text = anchorOf(target)?.text;
  const quote = typeof text === 'string' ? collapse(text).trim() : '';
  if (quote.length === 0) {
    const label = anchorLabel(target);
    return label === undefined
      ? undefined
      : { before: label, quote, after: '' };
  }

  const span =
    paragraph === undefined
      ? undefined
      : locateQuote([paragraph], quote, at ?? anchorAt(target));
  if (paragraph === undefined || span === undefined)
    return { before: '', quote, after: '' };

  return {
    before: lead(paragraph.slice(0, span.start.offset)),
    quote: collapse(paragraph.slice(span.start.offset, span.end.offset)),
    after: collapse(paragraph.slice(span.end.offset)).trimEnd(),
  };
};
