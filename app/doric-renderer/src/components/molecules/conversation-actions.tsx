import { createContext, type ReactNode, useContext } from 'react';

/**
 * What the document may ask the surface to do. A Lexical node carries data only —
 * a function is not a legal node property and could not be rebuilt from the log —
 * so the one block that acts, the composer, reads its behaviour from here.
 */
export type ConversationActions = {
  /** Sends the markdown the composer holds as a prompt. */
  readonly submit: (markdown: string) => void;
  /** Whether a prompt is already on its way, so the composer stays put. */
  readonly sending: boolean;
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
