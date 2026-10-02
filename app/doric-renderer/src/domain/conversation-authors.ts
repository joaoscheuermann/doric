/**
 * Who wrote a block of the conversation.
 *
 * A turn and the reader's own prompt both wear an author: the reader theirs,
 * the agent its. Neither identity is in the projection yet, so both are fixed
 * here — the one place that is replaced the day the host reports who is who.
 */

/** The reader at this install; their turns and their prompt wear this name. */
export const READER_NAME = 'jao.scheuermann';

/** The agent a Thread talks to. */
export const AGENT_NAME = 'agent';

/** The side of the conversation a line names. */
export type AuthorRole = 'agent' | 'user';

/** An author line as the sync plans it: who wrote the block, and how long ago. */
export type AuthorDraft = {
  readonly role: AuthorRole;
  readonly name: string;
  readonly at: string | undefined;
};
