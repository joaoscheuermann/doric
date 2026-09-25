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
