/**
 * The comments a person attaches to a prompt, and the one text they travel in.
 *
 * A prompt reaches the Thread's log as a single string, so the comments have to
 * survive inside it: what a person selected, and what they said about it, is
 * part of what the agent reads, and the log is the only copy that outlives the
 * window. The format is therefore plain Markdown rather than a serialized
 * payload, so the agent reads the sentences the person wrote and the log stays
 * legible to whoever reads it later.
 *
 * It exists for one property: `parsePrompt(composePrompt(comments, request))`
 * reads back the comments and the request it was given, whenever the request
 * does not itself begin with the comments heading. What the format cannot carry
 * back is stated rather than hidden, because each is a rule the writer chose: a
 * comment with an empty body is not written at all, a body is one line, and an
 * id names a comment's place in the text rather than anything durable.
 */

/**
 * One comment as the composer holds it: the text a person selected, and what
 * they said about it. The id is not part of the prompt — a surface needs a name
 * for the field it renders, so a parsed comment is given one instead of being
 * left anonymous.
 */
export type PromptComment = {
  readonly id: string;
  readonly quote: string;
  readonly body: string;
};

/**
 * The two headings the format is anchored on. They are exported because a
 * surface recognizes the same anchors to draw a sent prompt as comments and a
 * request, rather than as prose the person typed.
 */
export const COMMENTS_HEADING = '# User comments';
export const REQUEST_HEADING = '# User request';

/**
 * The quote as it is stored: one line, with no leading or trailing space. A
 * selection that spans a line break therefore stores as one line, because the
 * quote is later matched against an answer's own prose, where a line break is
 * the answer's layout and not the person's text.
 */
export const quoteOf = (selectionText: string): string =>
  selectionText.trim().replace(/\s+/g, ' ');

/**
 * One comment is one line, so a value is written as one: a line break becomes the
 * space it was typed as, and every `\` and `"` is escaped, because the closing
 * quote is the only character that could end the comment early and a backslash is
 * the only character that could escape it. Escaping both, in this order, is what
 * makes the pair symmetrical: whatever a person writes, `unescaped` reads back.
 */
const writtenLine = (value: string): string =>
  value
    .replace(/\r\n|\r|\n/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');

/**
 * The prompt a person's request becomes once their comments go with it.
 *
 * A comment with nothing in it is not a comment, so it is dropped; a person who
 * wrote none gets their request back unchanged rather than wrapped in headings
 * that would have the agent read a structure nobody wrote. The blocks are
 * separated by one blank line, which is what keeps the headings readable as
 * Markdown in the log.
 */
export const composePrompt = (
  comments: readonly PromptComment[],
  request: string,
): string => {
  const kept = comments.filter((comment) => comment.body.trim().length > 0);
  if (kept.length === 0) return request;
  const numbered = kept.map((comment, index) => {
    const number = String(index + 1);
    const quote = writtenLine(comment.quote);
    const body = writtenLine(comment.body);
    return `${number}. "${quote}": ${body}`;
  });
  return [COMMENTS_HEADING, ...numbered, '', REQUEST_HEADING, request].join(
    '\n',
  );
};

/**
 * A numbered comment line: `N. "quote": body`. The quote ends at the first `"`
 * that is not escaped and is followed by `: `, so a quote holding a quote of
 * its own is read back whole; a line that does not fit this shape is where the
 * comments block ends.
 */
const COMMENT_LINE = /^(\d+)\. "((?:[^"\\]|\\.)*)": (.*)$/;

/**
 * The value a written line holds: every escape the writer added, undone. A
 * backslash before anything is that character, which is exact because the writer
 * escaped every backslash of its own.
 */
const unescaped = (value: string): string => value.replace(/\\(.)/g, '$1');

/**
 * The request a text carries: everything after the first request heading and
 * the blank line that follows it, verbatim, so a request that itself holds that
 * heading keeps the text after the first one. A text with no heading carries no
 * request line, and then everything from the end of the comments block is the
 * request.
 */
const requestAfter = (lines: readonly string[], from: number): string => {
  const heading = lines.indexOf(REQUEST_HEADING, from);
  if (heading === -1) return lines.slice(from).join('\n');
  const rest = lines.slice(heading + 1);
  return (rest[0] === '' ? rest.slice(1) : rest).join('\n');
};

/**
 * The comments and request a framed text carries, or nothing when the text is not
 * framed at all.
 *
 * Framing is what a person's own request might imitate by accident, so it is only
 * believed when it is complete: the heading, one or more comment lines and nothing
 * else before the request heading, and a request line after it. A composed prompt
 * always looks like that; a request that merely begins with the heading does not,
 * and is therefore read as the request it is — which is what makes a request
 * beginning with `# User comments` come back unchanged.
 */
const framed = (
  lines: readonly string[],
):
  | { readonly comments: readonly PromptComment[]; readonly request: string }
  | undefined => {
  if (lines[0] !== COMMENTS_HEADING) return undefined;
  const heading = lines.indexOf(REQUEST_HEADING, 1);
  if (heading === -1) return undefined;
  // The writer separates the block from the request with one blank line, and
  // nothing else is a separator: a blank line anywhere else means this text is
  // not something this module wrote.
  const block = lines.slice(1, heading);
  if (block.at(-1) === '') block.pop();
  if (block.length === 0) return undefined;
  const comments: PromptComment[] = [];
  for (const line of block) {
    const match = COMMENT_LINE.exec(line);
    if (match === null) return undefined;
    comments.push({
      id: `parsed:${String(comments.length + 1)}`,
      quote: unescaped(match[2] ?? ''),
      body: unescaped(match[3] ?? ''),
    });
  }
  return { comments, request: requestAfter(lines, heading) };
};

/**
 * What a sent prompt says, read back: the comments and the request.
 *
 * A text that is not framed is a request, whole — the log holds prompts the host
 * was given and prompts a person typed, and only the framed ones carried comments.
 * A comment stored with an empty body stays empty here: the log held it that way,
 * and reading it back is not the place to drop it.
 */
export const parsePrompt = (
  text: string,
): {
  readonly comments: readonly PromptComment[];
  readonly request: string;
} => framed(text.split('\n')) ?? { comments: [], request: text };

/**
 * Where a stored quote appears in an answer's own text, if it does: the first
 * occurrence, plain and case-sensitive. A quote that spans a paragraph break in
 * the answer, or one the answer happens to hold several times, is the price of
 * keeping the sent prompt in the format the person reads — locating is a best
 * effort for marking, so it finds nothing rather than guessing which occurrence
 * was meant.
 */
export const locateQuote = (
  text: string,
  quote: string,
): { readonly start: number; readonly end: number } | undefined => {
  const start = text.indexOf(quote);
  return start === -1 ? undefined : { start, end: start + quote.length };
};
