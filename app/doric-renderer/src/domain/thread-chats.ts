import type { PendingSend } from './pending-turns';
import { emptyProjection, type Projection, projectEvents } from './projector';
import { acceptedHumanInputs } from './projector-input';
import type {
  Thread,
  ThreadEvent,
  ThreadHistory,
  ThreadUpdate,
} from './workspace';

/**
 * How many Threads the surface keeps open at once. The reader can switch between
 * them instantly, and each keeps its own watch, so the bound is what stops a
 * session from holding a subscription per Thread it ever passed through. A
 * Thread evicted here is reopened from `history` like any other.
 */
export const MAX_OPEN_THREADS = 20;

/**
 * One Thread's chat as the surface holds it: the record the stream keeps live,
 * the log projected into turns, the reader's words the log does not hold yet,
 * and the errors and in-flight send the surface draws. `subscribed` is true for
 * every Thread here — a watch is open for it — so a Thread without state is one
 * whose watch has been closed.
 */
export type ThreadChat = {
  readonly id: string;
  readonly thread: Thread;
  readonly projection: Projection;
  readonly error: string | undefined;
  readonly sending: boolean;
  readonly sendError: string | undefined;
  readonly pending: PendingSend | undefined;
  readonly subscribed: boolean;
};

/**
 * Every Thread the surface holds, each with its own state, and the order they
 * were last viewed in. `viewed` is the least recently viewed first, so the bound
 * drops from its head. `deleted` names Threads a `deleted` update dropped; the
 * surface explains them instead of drawing an empty log.
 */
export type ThreadChats = {
  readonly chats: ReadonlyMap<string, ThreadChat>;
  readonly viewed: readonly string[];
  readonly deleted: ReadonlySet<string>;
};

/** What a change asks the holder to do to the host's watches. */
export type ThreadChatEffect =
  | {
      readonly kind: 'watch';
      readonly id: string;
      readonly afterSequence: number;
    }
  | { readonly kind: 'unwatch'; readonly id: string };

/** A new set of chats, and the watches opening it requires. */
export type ThreadChatsChange = {
  readonly chats: ThreadChats;
  readonly effects: readonly ThreadChatEffect[];
};

export const emptyThreadChats: ThreadChats = {
  chats: new Map(),
  viewed: [],
  deleted: new Set(),
};

/** The same dict, with one Thread's chat replaced. */
const withChat = (
  state: ThreadChats,
  id: string,
  chat: ThreadChat,
): ThreadChats => {
  const chats = new Map(state.chats);
  chats.set(id, chat);
  return { chats, viewed: state.viewed, deleted: state.deleted };
};

/** The order with `id` moved to the most recently viewed end. */
const bumped = (viewed: readonly string[], id: string): readonly string[] => [
  ...viewed.filter((one) => one !== id),
  id,
];

/**
 * Keeps only the last `MAX_OPEN_THREADS` viewed Threads, dropping the least
 * recently viewed first and naming each watch to close. The just-viewed Thread
 * is at the end, so it is never the one dropped.
 */
const bounded = (state: ThreadChats): ThreadChatsChange => {
  const effects: ThreadChatEffect[] = [];
  const chats = new Map(state.chats);
  let viewed = state.viewed;

  while (viewed.length > MAX_OPEN_THREADS) {
    const [evicted, ...rest] = viewed;
    viewed = rest;
    if (chats.delete(evicted)) effects.push({ kind: 'unwatch', id: evicted });
  }

  return { chats: { chats, viewed, deleted: state.deleted }, effects };
};

/** The reader's own prompts: a Thread's input is not one of them. */
const ownPrompts = (projection: Projection): number =>
  acceptedHumanInputs(projection.inputs);

/**
 * Drops a pending send once the log holds one more prompt of the reader's own:
 * one more of them than there were when it left is the send being accepted,
 * whatever else the log has done since.
 */
const settled = (chat: ThreadChat): ThreadChat =>
  chat.pending !== undefined &&
  ownPrompts(chat.projection) > chat.pending.before
    ? { ...chat, pending: undefined }
    : chat;

/**
 * Marks the Thread the reader is looking at: its record is refreshed from the one
 * the sidebar holds, and it becomes the most recently viewed, which is what the
 * bound drops last. A Thread with no state is unaffected.
 */
export const showThread = (
  state: ThreadChats,
  thread: Thread,
): ThreadChatsChange => {
  const chat = state.chats.get(thread.id);
  if (chat === undefined) return { chats: state, effects: [] };

  // Showing the Thread already shown, with the record it already holds, changes
  // nothing: the surface keeps the same projection and no watcher moves.
  if (chat.thread === thread && state.viewed.at(-1) === thread.id)
    return { chats: state, effects: [] };

  const chats = new Map(state.chats);
  chats.set(thread.id, { ...chat, thread });
  return bounded({ ...state, chats, viewed: bumped(state.viewed, thread.id) });
};

/**
 * Opens a Thread: a Thread with no state is created from the cached history —
 * its record and its folded log — and subscribed from where that history ends,
 * or the whole log when the app holds none; one already held is only shown. The
 * Thread becomes the most recently viewed, so opening past the bound drops the
 * least recently viewed instead.
 */
export const openThread = (
  state: ThreadChats,
  thread: Thread,
  history: ThreadHistory | null,
): ThreadChatsChange => {
  // A deleted Thread stays deleted: a surface still holding it must not
  // resurrect its state, let alone open a watch the host cannot serve.
  if (state.deleted.has(thread.id)) return { chats: state, effects: [] };
  if (state.chats.has(thread.id)) return showThread(state, thread);

  const chat: ThreadChat = {
    id: thread.id,
    thread: history?.thread ?? thread,
    projection: projectEvents(emptyProjection, history?.events ?? []),
    error: undefined,
    sending: false,
    sendError: undefined,
    pending: undefined,
    subscribed: true,
  };
  const chats = new Map(state.chats).set(thread.id, chat);
  const opened = bounded({
    ...state,
    chats,
    viewed: bumped(state.viewed, thread.id),
  });

  return {
    chats: opened.chats,
    effects: [
      {
        kind: 'watch',
        id: thread.id,
        afterSequence: history?.lastSequence ?? 0,
      },
      ...opened.effects,
    ],
  };
};

/** Drops a deleted Thread's state and names its watch to close. */
export const dropThread = (
  state: ThreadChats,
  id: string,
): ThreadChatsChange => {
  if (!state.chats.has(id)) return { chats: state, effects: [] };

  const chats = new Map(state.chats);
  chats.delete(id);
  return {
    chats: {
      chats,
      viewed: state.viewed.filter((one) => one !== id),
      deleted: new Set([...state.deleted, id]),
    },
    effects: [{ kind: 'unwatch', id }],
  };
};

/**
 * The Thread an update belongs to. Every forwarded update names one: a stream
 * failure carries the Thread of the watch that raised it.
 */
const updateThreadId = (update: ThreadUpdate): string => {
  switch (update.kind) {
    case 'snapshot':
      return update.snapshot.threadId;
    case 'event':
      return update.event.threadId;
    case 'updated':
      return update.thread.id;
    case 'deleted':
      return update.threadId;
    case 'error':
      return update.threadId;
  }
};

/**
 * The events of one batch that belong to the Thread being read: a watch delivers
 * one Thread's updates, and a projection only absorbs its own.
 */
const ownEvents = (
  events: readonly ThreadEvent[],
  id: string,
): readonly ThreadEvent[] => events.filter((event) => event.threadId === id);

/**
 * Folds one batch of a Thread's events into its projection. Events named for
 * another Thread are dropped, so a foreign event cannot enter this Thread's log
 * however it was delivered.
 */
export const applyThreadEvents = (
  state: ThreadChats,
  id: string,
  events: readonly ThreadEvent[],
): ThreadChatsChange => {
  const chat = state.chats.get(id);
  if (chat === undefined) return { chats: state, effects: [] };

  const own = ownEvents(events, id);
  if (own.length === 0) return { chats: state, effects: [] };

  const next = settled({
    ...chat,
    projection: projectEvents(chat.projection, own),
  });
  return { chats: withChat(state, id, next), effects: [] };
};

/**
 * Applies one update to the Thread it belongs to. An update for a Thread the
 * surface does not hold, or one whose own id is not the watch's, changes
 * nothing: this is the view boundary the reported cross-Thread bug crossed.
 */
export const applyThreadUpdate = (
  state: ThreadChats,
  id: string,
  update: ThreadUpdate,
): ThreadChatsChange => {
  const chat = state.chats.get(id);
  if (chat === undefined) return { chats: state, effects: [] };

  const owner = updateThreadId(update);
  if (owner !== id) return { chats: state, effects: [] };

  switch (update.kind) {
    case 'snapshot': {
      // A snapshot contributes the events that are its own, exactly as a live
      // event does: one naming another Thread is dropped rather than projected.
      const own = ownEvents(update.snapshot.events, id);
      const next = settled({
        ...chat,
        thread: update.snapshot.thread ?? chat.thread,
        ...(own.length === 0
          ? {}
          : { projection: projectEvents(chat.projection, own) }),
      });
      return { chats: withChat(state, id, next), effects: [] };
    }
    case 'event':
      return applyThreadEvents(state, id, [update.event]);
    case 'updated':
      return {
        chats: withChat(state, id, { ...chat, thread: update.thread }),
        effects: [],
      };
    case 'error':
      return {
        chats: withChat(state, id, { ...chat, error: update.message }),
        effects: [],
      };
    case 'deleted':
      return dropThread(state, id);
  }
};

/** Records the words the reader has sent, which the log does not hold yet. */
export const startPending = (
  state: ThreadChats,
  id: string,
  text: string,
): ThreadChats => {
  const chat = state.chats.get(id);
  if (chat === undefined) return state;
  return withChat(state, id, {
    ...chat,
    pending: { text, before: ownPrompts(chat.projection) },
  });
};

/** Puts the words back when the host refused the send. */
export const clearPending = (state: ThreadChats, id: string): ThreadChats => {
  const chat = state.chats.get(id);
  if (chat === undefined || chat.pending === undefined) return state;
  return withChat(state, id, { ...chat, pending: undefined });
};

/** Whether the sending Thread's request is still in flight. */
export const withSending = (
  state: ThreadChats,
  id: string,
  sending: boolean,
): ThreadChats => {
  const chat = state.chats.get(id);
  if (chat === undefined) return state;
  return withChat(state, id, { ...chat, sending });
};

/** The failure a Thread's send surfaced, or its clearing. */
export const withSendError = (
  state: ThreadChats,
  id: string,
  message: string | undefined,
): ThreadChats => {
  const chat = state.chats.get(id);
  if (chat === undefined) return state;
  return withChat(state, id, { ...chat, sendError: message });
};
