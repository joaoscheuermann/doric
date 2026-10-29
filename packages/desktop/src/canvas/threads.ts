// `threads.ts` — the durable comments of one artifact, read off a Thread's log
// (`comments.*` events), and their grouping into threads: a root and its
// replies, `done` once resolved, `await` while the agent spoke last, `open`
// otherwise. Generic in the owner's anchor type: the anchor is read as the
// event recorded it, its shape is the owner's. Nothing here touches the DOM or
// a service: replay and rewind run it again over the same event list.

/** One event of a Thread's durable log, as any consumer reads it. */
export interface CanvasLogEvent {
  readonly type: string;
  readonly event: unknown;
  /** The prompt the event was written under, as the Thread's log names it. */
  readonly promptId?: string;
  readonly createdAt?: string;
}

/**
 * One durable comment on an artifact, as the `comments.*` events state it,
 * anchored by the owner's anchor type `A`.
 */
export interface CanvasComment<A> {
  readonly commentId: string;
  readonly text: string;
  readonly author?: string;
  readonly revision?: number;
  readonly anchor?: A;
  /** When the comment was written, when its event says so. */
  readonly createdAt?: string;
  /** The root this comment answers; absent on a root. */
  readonly inReplyTo?: string;
  /** Whether the comment was attended to (`comments.resolved/v1`). */
  readonly resolved: boolean;
  /** The prompt the comment was written under, when the log names it. */
  readonly promptId?: string;
}

/** The author the agent's answers are written under. */
export const AGENT_AUTHOR = 'agent';

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;

const positiveInt = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : undefined;

const stringOrUndefined = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

const commentOf = <A>(event: CanvasLogEvent): CanvasComment<A> | undefined => {
  const payload = record(event.event);

  if (payload === undefined) return undefined;

  const commentId = stringOrUndefined(payload.commentId);
  const text = typeof payload.text === 'string' ? payload.text : undefined;

  if (commentId === undefined || text === undefined) return undefined;

  const target = record(payload.target);
  // The anchor's shape is the owner's: read as recorded, unchecked.
  const anchor = record(target?.anchor) as A | undefined;
  const author = stringOrUndefined(payload.author);
  const revision = positiveInt(target?.revision);
  const createdAt =
    stringOrUndefined(payload.createdAt) ?? stringOrUndefined(event.createdAt);
  const inReplyTo = stringOrUndefined(payload.inReplyTo);
  const promptId = stringOrUndefined(event.promptId);

  return {
    commentId,
    text,
    ...(author === undefined ? {} : { author }),
    ...(revision === undefined ? {} : { revision }),
    ...(anchor === undefined ? {} : { anchor }),
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(inReplyTo === undefined ? {} : { inReplyTo }),
    resolved: false,
    ...(promptId === undefined ? {} : { promptId }),
  };
};

/**
 * Reads the durable comments of one artifact off the log, in order: every
 * `comments.added/v1` whose `target.id` is `artifactId`, on any revision,
 * each keeping the revision it was written on, with the prompt it was written
 * under and the attended state the later `comments.resolved/v1` events left
 * it in. An event without a `commentId` or a string `text` is skipped, and a
 * repeated `commentId` is the same comment (the first one stays). The anchor
 * is read as the event recorded it and typed as `A`, unchecked: its shape is
 * the owner's. Pure; never throws.
 */
export const commentsOfEvents = <A>(
  events: readonly CanvasLogEvent[],
  artifactId: string,
): readonly CanvasComment<A>[] => {
  const comments: CanvasComment<A>[] = [];
  const resolved = new Map<string, boolean>();

  for (const event of events) {
    if (event.type === 'comments.resolved/v1') {
      const payload = record(event.event);
      const commentId = stringOrUndefined(payload?.commentId);

      if (commentId !== undefined && typeof payload?.resolved === 'boolean')
        resolved.set(commentId, payload.resolved);

      continue;
    }

    if (event.type !== 'comments.added/v1') continue;

    const comment = commentOf<A>(event);
    const target = record(record(event.event)?.target);

    if (
      comment === undefined ||
      stringOrUndefined(target?.id) !== artifactId ||
      // A retried write with the same id is the same comment.
      comments.some((known) => known.commentId === comment.commentId)
    ) {
      continue;
    }

    comments.push(comment);
  }

  return comments.map((comment) =>
    resolved.has(comment.commentId)
      ? { ...comment, resolved: resolved.get(comment.commentId) === true }
      : comment,
  );
};

/**
 * Where a thread stands: `done` once its root is resolved, `await` while the
 * agent spoke last and the reader has not answered, `open` otherwise.
 */
export type ThreadState = 'open' | 'await' | 'done';

/** One root comment and the replies that answer it, in the order of the log. */
export interface CanvasThread<A> {
  readonly root: CanvasComment<A>;
  readonly replies: readonly CanvasComment<A>[];
  readonly state: ThreadState;
  /**
   * The pin's number: the root's place among the artifact's roots, whatever
   * revision each was written on — so a thread keeps its number across
   * revisions.
   */
  readonly pin: number;
}

/** The state of a thread, from its root and its replies. */
export const threadStateOf = <A>(
  root: CanvasComment<A>,
  replies: readonly CanvasComment<A>[],
): ThreadState => {
  if (root.resolved) return 'done';

  const last = replies[replies.length - 1] ?? root;

  return last.author === AGENT_AUTHOR ? 'await' : 'open';
};

/**
 * Groups comments into threads: each root (a comment that answers nothing)
 * with its replies. A reply that names another reply belongs to that reply's
 * root, a reply whose root is not among the comments has no thread to join,
 * and a reply cycle joins none. Roots are numbered from 1 by their order,
 * which is the pin they wear.
 */
export const threadsOf = <A>(
  comments: readonly CanvasComment<A>[],
): readonly CanvasThread<A>[] => {
  const byId = new Map(comments.map((comment) => [comment.commentId, comment]));
  const rootIdOf = (comment: CanvasComment<A>): string | undefined => {
    let current: CanvasComment<A> | undefined = comment;
    const seen = new Set<string>();

    while (current?.inReplyTo !== undefined) {
      if (seen.has(current.commentId)) return undefined;
      seen.add(current.commentId);
      current = byId.get(current.inReplyTo);
    }

    return current?.commentId;
  };

  const roots = comments.filter((comment) => comment.inReplyTo === undefined);

  return roots.map((root, index) => {
    const replies = comments.filter(
      (comment) =>
        comment.inReplyTo !== undefined && rootIdOf(comment) === root.commentId,
    );

    return {
      root,
      replies,
      state: threadStateOf(root, replies),
      pin: index + 1,
    };
  });
};
