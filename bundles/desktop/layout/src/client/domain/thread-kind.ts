import type { Thread } from './workspace.js';

/**
 * What a Thread is, from who opened it and under what:
 *
 * - `main` — the Project's own Thread, opened by the reader;
 * - `sub-thread` — a Thread the reader opened inside a main Thread, which the
 *   reader controls exactly like a main one;
 * - `sub-agent` — a Thread an agent spawned, which the reader can only watch,
 *   pause, continue and retry.
 *
 * A Thread written before the host recorded who opened it carries no `origin`
 * and reads as the reader's, so an existing workspace keeps every Thread it
 * had, as a main Thread or as the sub-thread it already looked like.
 */
export type ThreadKind = 'main' | 'sub-thread' | 'sub-agent';

/**
 * The glyph a Thread of each kind wears, named rather than imported so the rule
 * can be stated and tested without React. Every Thread is a conversation; the
 * kind adds to the bubble instead of replacing it with its working directory.
 */
export type ThreadKindIconName =
  | 'message-circle'
  | 'message-circle-plus'
  | 'bot-message-square';

export const threadKindIcon: Record<ThreadKind, ThreadKindIconName> = {
  main: 'message-circle',
  'sub-thread': 'message-circle-plus',
  'sub-agent': 'bot-message-square',
};

/** The kind a Thread is, decided from its parent and who opened it. */
export const threadKind = (thread: Thread): ThreadKind => {
  if (thread.parentThreadId === undefined) return 'main';
  return thread.origin === 'agent' ? 'sub-agent' : 'sub-thread';
};

/** What each kind is called where a surface has room for words. */
export const threadKindLabel: Record<ThreadKind, string> = {
  main: 'Main thread',
  'sub-thread': 'Sub-thread',
  'sub-agent': 'Agent thread',
};

/**
 * The one line that says who controls the Thread. It is the tooltip of a row's
 * kind mark and the lead of the bar an agent Thread carries instead of a
 * composer, so the rule is stated once.
 */
export const threadKindHint: Record<ThreadKind, string> = {
  main: 'Main thread · you control it',
  'sub-thread': 'Sub-thread · you control it',
  'sub-agent': 'Agent thread · you can pause, continue or retry it',
};

/** The handle the reader has on a Thread of one kind. */
export type ThreadControl = {
  /** The reader writes prompts and stops the run. */
  readonly prompts: boolean;
  /** The reader pauses, continues and retries a run it did not start. */
  readonly supervises: boolean;
  readonly renames: boolean;
  readonly deletes: boolean;
  /** The reader opens a sub-thread under it. */
  readonly branches: boolean;
};

const CONTROL: Record<ThreadKind, ThreadControl> = {
  main: {
    prompts: true,
    supervises: false,
    renames: true,
    deletes: true,
    branches: true,
  },
  'sub-thread': {
    prompts: true,
    supervises: false,
    renames: true,
    deletes: true,
    // A sub-thread lives inside a main Thread; the reader branches the main
    // one, not the branch it already is.
    branches: false,
  },
  'sub-agent': {
    // The agent that spawned it owns what it says and when it runs: the reader
    // only holds the three levers below.
    prompts: false,
    supervises: true,
    renames: false,
    deletes: false,
    branches: false,
  },
};

/** The handle the reader has on `thread`. */
export const threadControl = (thread: Thread): ThreadControl =>
  CONTROL[threadKind(thread)];

/**
 * The Thread a surface may open under `parent` on behalf of `by`: the reader
 * branches a main Thread into a sub-thread, and an agent working in any Thread
 * spawns a sub-agent Thread. Anything else has no kind to create.
 */
export const childThreadKind = (
  parent: ThreadKind,
  by: 'user' | 'agent',
): ThreadKind | undefined => {
  if (by === 'agent') return 'sub-agent';
  return parent === 'main' ? 'sub-thread' : undefined;
};

/** Whether `kind` may be opened under `parent` by anyone at all. */
export const canHoldChild = (parent: ThreadKind, kind: ThreadKind): boolean =>
  parent === 'main'
    ? kind === 'sub-thread' || kind === 'sub-agent'
    : kind === 'sub-agent';
