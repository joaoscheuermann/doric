import type { PromptComment } from '@/domain/comments';
import { createContext, type ReactNode, useContext } from 'react';

/**
 * What the document may ask the surface to do. A Lexical node carries data only —
 * a function is not a legal node property and could not be rebuilt from the log —
 * so every block that acts reads its behaviour from here.
 */
export type ConversationActions = {
  /** Sends the markdown the composer holds as a prompt. */
  readonly submit: (markdown: string) => void;
  /** Sends a rewritten prompt in place of the one it replaces, discarding what
   * follows it. */
  readonly rewind: (promptId: string, markdown: string) => void;
  /** Rewrites one of the person's own earlier turns, keeping its comments. */
  readonly beginEdit: (promptId: string) => void;
  readonly cancelEdit: () => void;
  /** Whether a prompt is already on its way, so the composer stays put. */
  readonly sending: boolean;
  /**
   * The comments written and not yet sent. A field reads its own words from here
   * rather than from the node that renders it, so the input is the state and not a
   * copy of it that could drift.
   */
  readonly comments: readonly PromptComment[];
  /** Replaces the body of a pending comment. */
  readonly commentBody: (id: string, body: string) => void;
  /** Removes a pending comment, and the field that holds it. */
  readonly removeComment: (id: string) => void;
  /** Opens or closes one fold, named by `foldKey`. */
  readonly toggleFold: (key: string) => void;
};

const actions = createContext<ConversationActions | undefined>(undefined);

export function ConversationActionsProvider({
  children,
  value,
}: {
  readonly children: ReactNode;
  readonly value: ConversationActions;
}) {
  return <actions.Provider value={value}>{children}</actions.Provider>;
}

/** The actions a block was given, or nothing outside a conversation. */
export const useConversationActions = (): ConversationActions | undefined =>
  useContext(actions);
