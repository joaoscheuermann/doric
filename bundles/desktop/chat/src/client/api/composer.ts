// The chat's binding to `chat.composer/v1`, the desktopMain service this
// bundle's own desktop part provides: the draft text and the comment stack of
// every Thread, one state shared by every window. This is the only client code
// that calls the composer's contract; the stores and the send path go through
// it, so the scope a call carries is decided in one place.
//
// The composer's methods are bridge calls (plain data); `registerFlush` is not
// — it carries a function, so it only serves callers in the main process, which
// is where every kind's owner registers the flush of its kind.

import type { CallScope, Services } from 'bundle/contracts';
import { CommentsV1 } from 'comments/contracts';

import {
  ChatComposerV1,
  type ComposerAddInput,
  type ComposerItem,
  type ComposerSnapshot,
  type ComposerWatchItem,
} from '../../contracts/index.js';
import { chatServices } from '../services/chat-services.js';

/** What the composer's watch hands its listener. */
export type ComposerWatchListener = (item: ComposerWatchItem) => void;

/** The composer as the client sees it; every call is best effort, never fatal. */
export interface ComposerFeed {
  /** The Thread's portrait, or `undefined` while the service is unreachable. */
  read(thread: {
    id: string;
    projectId: string;
  }): Promise<ComposerSnapshot | undefined>;
  /** The portrait first, then the deltas; the release ends the watch. */
  watch(
    thread: { id: string; projectId: string },
    listener: ComposerWatchListener,
  ): () => void;
  /** Writes the words the editor holds, so the draft survives the navigation. */
  setText(thread: { id: string; projectId: string }, text: string): void;
  /** Adds one item to the Thread's stack. */
  add(
    thread: { id: string; projectId: string },
    input: Omit<ComposerAddInput, 'threadId'>,
  ): Promise<ComposerItem | undefined>;
  /** Edits one item's note. */
  note(
    thread: { id: string; projectId: string },
    id: string,
    note: string,
  ): void;
  /** Removes one item from the Thread's stack. */
  remove(thread: { id: string; projectId: string }, id: string): void;
  /**
   * The send flush: the prompt was accepted, so each item of the stack runs
   * the flush its kind registered and the sender performs the comment writes
   * it answered, in the scope of the accepted prompt. An item whose write
   * fails goes back on the stack. A refused send never reaches here, which is
   * what keeps the stack where it was.
   */
  flushAfterSend(input: {
    readonly threadId: string;
    readonly projectId: string;
    readonly promptId: string;
  }): Promise<void>;
}

const threadScope = (thread: { id: string; projectId: string }): CallScope => ({
  projectId: thread.projectId,
  threadId: thread.id,
});

/** The one call to `use` this bundle's composer makes per scope. */
const composerFor = (scope: CallScope) =>
  chatServices().use(ChatComposerV1, scope);

/**
 * The composer over the chat's activation services. The chat provides the
 * service itself, so a failure to reach it means the desktop part is not
 * running: the answer is an empty draft rather than a failed conversation.
 */
export const createComposerFeed = (
  services: () => Services = chatServices,
): ComposerFeed => {
  /** Runs a call, reporting `undefined` when the service is unreachable. */
  const attempt = async <T>(run: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await run();
    } catch (error) {
      console.error('Doric: the composer service is unreachable:', error);
      return undefined;
    }
  };

  /** Runs a call, quietly, when it can only fail by being unreachable. */
  const quietly = (run: () => void): void => {
    try {
      run();
    } catch {
      // A draft the window cannot reach is a draft the window cannot write;
      // the conversation keeps working, and the send says what it always did.
    }
  };

  return {
    read: (thread) =>
      attempt(async () =>
        composerFor(threadScope(thread)).read({ threadId: thread.id }),
      ),

    watch: (thread, listener) => {
      try {
        const subscription = composerFor(threadScope(thread)).watch(
          thread.id,
          listener,
        );

        return () => subscription.dispose();
      } catch {
        // Without the service there is nothing to watch: no items, no deltas.
        return () => undefined;
      }
    },

    setText: (thread, text) =>
      quietly(
        () =>
          void composerFor(threadScope(thread)).setText({
            threadId: thread.id,
            text,
          }),
      ),

    add: (thread, input) =>
      attempt(async () =>
        composerFor(threadScope(thread)).addItem({
          threadId: thread.id,
          ...input,
        }),
      ),

    note: (thread, id, note) =>
      quietly(
        () =>
          void composerFor(threadScope(thread)).updateNote({
            threadId: thread.id,
            id,
            note,
          }),
      ),

    remove: (thread, id) =>
      quietly(
        () =>
          void composerFor(threadScope(thread)).removeItem({
            threadId: thread.id,
            id,
          }),
      ),

    flushAfterSend: async (input) => {
      // The flush answers the writes; the sender window performs them, in the
      // scope of the prompt the host just accepted, so the events land in this
      // Thread's log right below the reader's turn.
      const scope = { projectId: input.projectId, threadId: input.threadId };
      const flushed = await attempt(async () =>
        composerFor(scope).flush({
          threadId: input.threadId,
          promptId: input.promptId,
        }),
      );

      if (flushed === undefined || flushed.length === 0) return;

      const comments = services().use(CommentsV1, {
        ...scope,
        promptId: input.promptId,
      });

      for (const { item, writes } of flushed) {
        // Each item's writes land on their own: one that fails never keeps
        // the rest of the send behind it. The stack has already handed the
        // item over, so an item whose write failed goes back on the stack —
        // a comment the log never received stays a draft to send again, under
        // the same comment id (the write is idempotent on it, and a reply
        // still names it).
        try {
          for (const write of writes) await comments.add(write);
        } catch (error) {
          console.error(
            'Doric: a flushed comment could not be written:',
            error,
          );
          await attempt(async () =>
            composerFor(scope).addItem({
              threadId: input.threadId,
              id: item.id,
              kind: item.kind,
              elementTag: item.elementTag,
              data: item.data,
              ...(item.author === undefined ? {} : { author: item.author }),
              note: item.note,
            }),
          );
        }
      }
    },
  };
};

/** The composer over the chat's activation services. */
export const composerFeed: ComposerFeed = createComposerFeed();
