// The reader's picks of a question form and the answers they become
// (conversation-openui.md D21), copied from `threads`' `domain/ask.ts`.

import type { AskAnswer, AskQuestion } from '../../contracts/index.js';

/** The pick that stands for the free answer. It is never sent as a label. */
export const OTHER = '__other__';

/** What the reader chose for one question: labels picked, plus `OTHER` when the free answer is picked; `other` is its text. */
interface Picked {
  readonly picked: readonly string[];
  readonly other?: string;
}

/** The reader's picks, by question id. */
export type Picks = Readonly<Record<string, Picked>>;

/** The free answer's text when its row is picked and the text is not blank. */
const freeText = (a: Picked | undefined): string | undefined =>
  a?.picked.includes(OTHER) && (a.other ?? '').trim().length > 0
    ? a.other
    : undefined;

/** Whether a question can be sent: an option picked, or `OTHER` picked with non-blank text. `undefined` is not filled. */
export const filled = (a: Picked | undefined): boolean =>
  a !== undefined &&
  (a.picked.some((p) => p !== OTHER) || freeText(a) !== undefined);

/** The one-line answer: picked labels, then the free text when `OTHER` is picked with non-empty text, joined by ", ". 'Skipped' when not `filled`. */
export const summary = (a: Picked | undefined): string => {
  if (a === undefined || !filled(a)) return 'Skipped';
  const words = a.picked.filter((p) => p !== OTHER);
  if (a.picked.includes(OTHER) && a.other) words.push(a.other);
  return words.join(', ');
};

/**
 * The answers `Ask.answer` takes, one per question, in `questions` order:
 * `options` = labels picked except `OTHER`; `other` only when `OTHER` is picked
 * and its text is not blank. A question without picks gives `{ id, options: [] }`.
 * Never throws.
 */
export const toAnswers = (
  questions: readonly AskQuestion[],
  picks: Picks,
): readonly AskAnswer[] =>
  questions.map(({ id }) => {
    const a = picks[id];
    const other = freeText(a);
    return {
      id,
      options: (a?.picked ?? []).filter((p) => p !== OTHER),
      ...(other === undefined ? {} : { other }),
    };
  });

/** The picks recorded answers stand for: each answer's labels, plus `OTHER` with its text when it carries `other`. */
export const fromAnswers = (answers: readonly AskAnswer[]): Picks =>
  Object.fromEntries(
    answers.map(({ id, options, other }) => [
      id,
      other === undefined
        ? { picked: options }
        : { picked: [...options, OTHER], other },
    ]),
  );
