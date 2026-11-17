/*
 * The fence and question-form line rules a window draws by and the host
 * archives by (runtime.threads/v1 1.8.0): one copy, so what chat draws as a
 * question form and what the host counts as one never disagree. Pure and
 * browser-safe.
 */

/**
 * The marker a line opens a fence with: optional whitespace, then three or
 * more backticks or tildes; undefined when it opens none.
 */
export const fenceMarker = (line: string): string | undefined =>
  /^\s*(`{3,}|~{3,})/.exec(line)?.[1];

/**
 * Whether `line` closes a fence `marker` opened: optional whitespace, at
 * least as many of the marker's character, then only whitespace.
 */
export const closesFence = (line: string, marker: string): boolean => {
  const match = /^\s*(`{3,}|~{3,})\s*$/.exec(line)?.[1];
  return (
    match !== undefined &&
    match[0] === marker[0] &&
    match.length >= marker.length
  );
};

/**
 * An opener's info (the line after its marker, trimmed) and tag (the info's
 * first whitespace-separated word, '' when none).
 */
export const fenceInfo = (
  opener: string,
): { readonly info: string; readonly tag: string } => {
  const info = opener.replace(/^\s*(`{3,}|~{3,})/, '').trim();
  return { info, tag: info.split(/\s+/)[0] ?? '' };
};

/** D21 of docs/designs/conversation-openui.md: /^root\s*=\s*AskForm\(/. */
export const isQuestionLine = (line: string): boolean =>
  /^root\s*=\s*AskForm\(/.test(line);

/**
 * A fence body's completed statements: the whole body when `closed` or when
 * it ends with '\n'; otherwise every line but the last, '' when there is one
 * line.
 */
export const completedStatements = (body: string, closed: boolean): string => {
  if (closed || body.endsWith('\n')) return body;
  const end = body.lastIndexOf('\n');
  return end < 0 ? '' : body.slice(0, end);
};

/**
 * The first non-blank line of completedStatements(body, closed); undefined
 * when there is none.
 */
export const firstCompletedLine = (
  body: string,
  closed: boolean,
): string | undefined =>
  completedStatements(body, closed)
    .split('\n')
    .find((line) => line.trim() !== '');

/** The fence tag of a question form. */
export const questionFenceTag = 'openui-lang';

/**
 * Whether `text`, trimmed, holds a question form. Walking its lines, a line
 * with a fenceMarker opens a fence; the fence's body is every following line
 * up to the first that closesFence(line, marker), or to the end (then it is
 * not closed); the body's lines join with '\n'. A fence whose tag is
 * questionFenceTag and whose firstCompletedLine(body, closed) passes
 * isQuestionLine is a question form. Never throws.
 */
export const hasQuestionForm = (text: string): boolean => {
  const lines = text.trim().split('\n');
  let index = 0;
  while (index < lines.length) {
    const opener = lines[index] ?? '';
    index += 1;
    const marker = fenceMarker(opener);
    if (marker === undefined) continue;
    const start = index;
    while (index < lines.length && !closesFence(lines[index] ?? '', marker))
      index += 1;
    const closed = index < lines.length;
    const body = lines.slice(start, index).join('\n');
    if (closed) index += 1;
    if (fenceInfo(opener).tag !== questionFenceTag) continue;
    const first = firstCompletedLine(body, closed);
    if (first !== undefined && isQuestionLine(first)) return true;
  }
  return false;
};
