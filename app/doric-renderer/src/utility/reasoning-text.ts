/**
 * How a run of the agent's reasoning reads: one flow of prose. A model streams
 * its reasoning with the line breaks its own format uses — a chunk often ends in
 * a run of them — so the block rendered verbatim reads as one word per line with
 * blank lines between the words. Those breaks separate tokens, not paragraphs:
 * a run of whitespace around them collapses to a single space when the model put
 * a space there too, and to nothing when it did not, so a word the model split
 * across chunks stays one word. The answer the agent writes is a separate turn
 * and keeps its own layout.
 */
export const reasoningText = (value: string): string =>
  value.replace(/\s*\n\s*/gu, (run) => (/[ \t]/.test(run) ? ' ' : '')).trim();
