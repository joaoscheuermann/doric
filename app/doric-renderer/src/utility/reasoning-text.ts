/**
 * How a run of the agent's reasoning reads: the model's prose, with the
 * paragraphs and lines it meant.
 *
 * A model streams its reasoning with the line breaks its own format uses, and
 * those breaks are mostly noise: a run splits between nearly every word, so the
 * raw text reads one word per line. A break is therefore read as the separator it
 * stands for — the space the words kept around it, or nothing when the chunks
 * split a word — and the text joins back into the prose the model wrote.
 *
 * Two breaks are worth keeping. A line the model opens like a list or a quote is
 * structure, so it keeps its own line. A run a sentence ends on — or one a new
 * sentence starts after — marks the paragraph the model meant, so a blank line
 * there opens a new one. Every other break, blank or not, is the stream's own.
 *
 * What a break means is told from the characters beside it alone — a few before,
 * and the line it opens — because this reads a run of reasoning on every render
 * and the reasoning runs to hundreds of thousands of characters. A rule that
 * looked back over the whole text would turn one render into a second of work.
 */
const sentenceEnd = /[.!?:]["')\]}]*$/;
const lineOpener = /^(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|>\s)/;
const sentenceStart = /^[A-Z0-9"'`([]/;

/** How far a break's verdict looks: a sentence's end is this close to it. */
const LOOKBACK = 8;
/** How far a break's verdict looks ahead: a line's opener is this short. */
const LOOKAHEAD = 32;

const breakOf = (run: string): string => (/[ \t]/.test(run) ? ' ' : '');

const endsSentence = (before: string): boolean =>
  sentenceEnd.test(before.replace(/[ \t]+$/, ''));

/** The line a break opens: its first characters, which an opener is read from. */
const nextLine = (value: string, start: number): string =>
  value
    .slice(start, start + LOOKAHEAD)
    .split('\n', 1)[0]
    .trimStart();

export const reasoningText = (value: string): string =>
  value
    .replace(/\s*\n+\s*/gu, (run, offset: number) => {
      const start = offset + run.length;
      const next = nextLine(value, start);
      if (lineOpener.test(next)) return '\n';
      if (/[ \t]/.test(run)) return breakOf(run);
      const lines = (run.match(/\n/g) ?? []).length;
      if (lines >= 2 && sentenceStart.test(next)) return '\n\n';
      const before = value.slice(Math.max(0, offset - LOOKBACK), offset);
      if (!endsSentence(before)) return breakOf(run);
      return lines >= 2 ? '\n\n' : ' ';
    })
    .trim();
