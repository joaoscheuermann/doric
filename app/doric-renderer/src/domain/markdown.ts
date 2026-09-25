/**
 * Rules about markdown text the renderer handles as data rather than as prose.
 */

/**
 * `value` as a fenced code block, in the shortest fence that can hold it: a
 * fence has to be longer than the longest run of backticks inside, or the block
 * would end early and the rest of the value would be read as markdown. A tool's
 * payload and its output are data, so this is how they reach the document
 * without any of their characters being interpreted.
 */
export const fenced = (value: string, language?: string): string => {
  const longest = [...value.matchAll(/`+/g)].reduce(
    (length, run) => Math.max(length, run[0].length),
    0,
  );
  const fence = '`'.repeat(Math.max(3, longest + 1));
  const info = language === undefined ? '' : language;
  return `${fence}${info}\n${value}\n${fence}`;
};

/**
 * A text with every run of whitespace collapsed to one space, and where each of
 * its characters came from.
 *
 * It exists because a person's selection and the document disagree about line
 * breaks: selecting three lines stores a quote with the whitespace between them
 * folded away, while the document still holds the newlines it renders as lines.
 * Searching the folded text finds the span; `offsets` translates that span back
 * into the document's own positions, so the mark lands on the words that were
 * selected rather than on an earlier occurrence of the same characters.
 */
export const collapsed = (
  value: string,
): {
  readonly text: string;
  readonly offsets: readonly number[];
} => {
  let text = '';
  const offsets: number[] = [];
  let pendingSpace = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? '';
    if (/\s/.test(character)) {
      pendingSpace = true;
      continue;
    }
    // A run of whitespace becomes one space, and never a leading or trailing one,
    // so the folded text begins and ends on a character a quote can name.
    if (pendingSpace && text.length > 0) {
      text += ' ';
      offsets.push(index);
    }
    pendingSpace = false;
    text += character;
    offsets.push(index);
  }
  return { offsets, text };
};
