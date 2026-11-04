/**
 * Who wrote a block of the conversation.
 *
 * A turn and the reader's own prompt both wear an author: the reader theirs,
 * the agent its. Neither identity is in the projection yet, so both are fixed
 * here — the one place that is replaced the day the host reports who is who.
 */

/** The reader at this install; their turns and their prompt wear this name. */
export { READER_NAME } from '../../contracts/index.js';

/** The agent a Thread talks to. */
export const AGENT_NAME = 'agent';

/** The side of the conversation a line names. */
export type AuthorRole = 'agent' | 'user';

/** The model that answered a turn, as the runtime recorded it. */
export type AnsweredBy = {
  readonly providerId: string;
  readonly model: string;
};

/** An author line as the sync plans it: who wrote the block, and how long ago. */
export type AuthorDraft = {
  readonly role: AuthorRole;
  readonly name: string;
  readonly at: string | undefined;
};

/**
 * The mark a block wears in the gutter as the sync plans it: who wrote it. The
 * reader's turn wears it with its author line; the agent's run wears it on the
 * run's first answer while the line trails the run's last turn. An agent mark
 * carries the model that answered the turn wearing it, when the log names one;
 * a reader's mark, and a bundle instruction's agent mark, never carry one.
 */
export type AuthorMark = {
  readonly role: AuthorRole;
  readonly name: string;
  readonly answeredBy?: AnsweredBy;
};
