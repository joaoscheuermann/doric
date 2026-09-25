import type { ConversationActions } from '@/components/molecules/conversation-actions';
import { composePrompt, type PromptComment } from '@/domain/comments';
import {
  type ConversationState,
  conversationState,
  type ConversationTurn,
  conversationTurns,
  emptyConversationState,
} from '@/domain/conversation';
import type { Thread } from '@/domain/workspace';
import { useThreadChat } from '@/hooks/use-thread-chat';
import { useCallback, useMemo, useRef, useState } from 'react';

/** What the conversation surface reads and what it can be asked to do. */
export type Conversation = {
  readonly turns: readonly ConversationTurn[];
  readonly actions: ConversationActions;
  /** What the person is doing: pending comments, folds, the prompt being edited. */
  readonly state: ConversationState;
  /**
   * Writes a comment on a span of an answer and reports it, so the document can
   * put the field that holds it below the line it was taken from. A comment exists
   * as soon as it is made — its body may still be empty — because the field has to
   * have something to edit.
   */
  readonly addComment: (quote: string) => PromptComment;
  /** A subscription or send failure, which the surface is expected to show. */
  readonly error: string | undefined;
  /**
   * How many prompts have been accepted. The document reads it to know when the
   * composer must be emptied — the one write the surface makes in the person's own
   * words, and only after they were sent.
   */
  readonly clear: number;
  /**
   * How many finished `write`, `edit` or `terminal` calls the log holds: the signal
   * that the sandbox the Thread shares has changed.
   */
  readonly writes: number;
};

/**
 * The conversation's own state, and the only place it is decided: which turns the
 * log renders, what the composer sends, and what the person is doing to it. It
 * renders nothing — the surface reads it and the document follows it.
 */
export const useConversation = (thread: Thread): Conversation => {
  const chat = useThreadChat(thread);
  const [state, setState] = useState<ConversationState>(emptyConversationState);
  const [clear, setClear] = useState(0);
  /** Names the comments made in this session, so no two ever share a name. */
  const made = useRef(0);
  /**
   * Whether a prompt is already on its way, from the moment it is asked for rather
   * than from the next render: two keystrokes in one batch must not send the same
   * comment-bearing prompt twice.
   */
  const inFlight = useRef(false);

  const dispatch = useCallback(
    (input: Parameters<typeof conversationState>[1]) => {
      setState((current) => conversationState(current, input));
    },
    [],
  );

  const turns = useMemo(
    () => conversationTurns(chat.turns, state),
    [chat.turns, state],
  );

  const addComment = useCallback(
    (quote: string): PromptComment => {
      made.current += 1;
      const comment: PromptComment = {
        body: '',
        id: `comment:${String(made.current)}`,
        quote,
      };
      dispatch({ kind: 'comment-added', comment });
      return comment;
    },
    [dispatch],
  );

  /** Sends one prompt, and never two at once. */
  const sendOnce = useCallback(
    (work: () => Promise<boolean>, done: () => void): void => {
      if (inFlight.current) return;
      inFlight.current = true;
      void work()
        .then((accepted) => {
          if (accepted) done();
        })
        .finally(() => {
          inFlight.current = false;
        });
    },
    [],
  );

  const submit = useCallback(
    (markdown: string): void => {
      const request = markdown.trim();
      if (chat.sending || request.length === 0) return;
      // A comment is not a second message: it is the same prompt, sent with the
      // request it was written about, in the format `parsePrompt` reads back.
      sendOnce(
        () => chat.prompt(composePrompt(state.comments, request)),
        () => {
          setClear((count) => count + 1);
          dispatch({ kind: 'submitted' });
        },
      );
    },
    [chat, dispatch, sendOnce, state.comments],
  );

  const rewind = useCallback(
    (promptId: string, markdown: string): void => {
      const request = markdown.trim();
      if (chat.sending || request.length === 0) return;
      // Rewriting a prompt sends the same kind of prompt: the edited words, with
      // the comments that prompt already carried. The host discards what followed
      // it, so a resubmit is a conversation that continues from there — and the
      // composer's draft is one of the things it discards, so the document empties
      // it on the same signal a sent prompt uses.
      sendOnce(
        () => chat.rewind(promptId, composePrompt(state.editComments, request)),
        () => {
          setClear((count) => count + 1);
          dispatch({ kind: 'submitted' });
        },
      );
    },
    [chat, dispatch, sendOnce, state.editComments],
  );

  const beginEdit = useCallback(
    (promptId: string): void => {
      const turn = turns.find(
        (entry) => entry.role === 'user' && entry.promptId === promptId,
      );
      // Only the person's own writing can be rewritten: a delegated input belongs
      // to another Thread, and the composer is the draft itself, whose words are
      // not in the log to be replaced.
      if (turn === undefined || turn.draft || turn.label !== undefined) return;
      // The comments the prompt carried come back with it: rewriting the request
      // must not throw away what the person already said about the answer.
      dispatch({
        comments: turn.comments ?? [],
        kind: 'edit-started',
        promptId,
      });
    },
    [dispatch, turns],
  );

  const cancelEdit = useCallback(
    () => dispatch({ kind: 'edit-cancelled' }),
    [dispatch],
  );

  const actions = useMemo<ConversationActions>(
    () => ({
      beginEdit,
      cancelEdit,
      commentBody: (id, body) => dispatch({ kind: 'comment-body', id, body }),
      comments: [...state.comments, ...state.editComments],
      removeComment: (id) => dispatch({ kind: 'comment-removed', id }),
      rewind,
      sending: chat.sending,
      submit,
      toggleFold: (key) => dispatch({ kind: 'fold-toggled', key }),
    }),
    [
      beginEdit,
      cancelEdit,
      chat.sending,
      dispatch,
      rewind,
      state.comments,
      state.editComments,
      submit,
    ],
  );

  return {
    actions,
    addComment,
    clear,
    error: chat.sendError ?? chat.error,
    state,
    turns,
    writes: chat.writes,
  };
};
