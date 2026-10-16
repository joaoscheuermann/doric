// `domain/preview-state.ts` — the pure reducer of `artifacts.*` events into
// one `PreviewState` (spec: "Uma superfície, duas molduras").
//
// It is the *same* reducer the chat projector runs over the log and the canvas
// window runs over the events it reads, so a node and a window reconstruct the
// same durable state of a preview: which revisions exist, which one the node
// was created with, which are approved. Nothing here touches the DOM or a
// service: replay and rewind run it again over the same event list.
//
// The projector must not claim the events of kinds that are not `preview`: the
// generic artifacts frame (in the `artifacts` bundle) owns those, and this
// reducer ignores them — only a `preview` artifact ever enters the state.

import type { ArtifactRecord, CommentAnchor } from '../../contracts/index.js';

/** One event of a Thread's durable log, as any consumer reads it. */
export interface PreviewLogEvent {
  readonly type: string;
  readonly event: unknown;
}

/** One revision of a preview, as the durable events state it. */
export interface PreviewRevisionState {
  readonly revision: number;
  readonly title?: string;
  /** Set by `artifacts.approved/v1`, only under the `request` policy. */
  readonly approved: boolean;
}

/**
 * The `PreviewState` of the spec: the durable view of one preview the
 * projector and the window share. The artifact registry's read resolves the
 * same shape from its record (see `previewStateOfRecord`).
 */
export interface PreviewState {
  readonly artifactId: string;
  readonly kind: 'preview';
  readonly title?: string;
  /** Ascending by revision; the last is the newest. */
  readonly revisions: readonly PreviewRevisionState[];
  /** Which revision the node was created with; the window opens at `latest`. */
  readonly latest: number;
}

/** The reducer's state: the preview state of every artifact the log names. */
export type PreviewStates = ReadonlyMap<string, PreviewState>;

/** The empty state replay starts from. */
export const initialPreviewStates = (): PreviewStates => new Map();

/** What one applied event changed, if anything. */
export interface PreviewEventChange {
  readonly artifactId: string;
  readonly revision: number;
}

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

interface CreatedPayload {
  readonly artifactId: string;
  readonly revision: number;
  readonly kind: string;
  readonly title?: string;
}

const createdOf = (event: PreviewLogEvent): CreatedPayload | undefined => {
  const payload = record(event.event);

  if (payload === undefined) return undefined;

  const artifactId = stringOrUndefined(payload.artifactId);
  const revision = positiveInt(payload.revision);
  const kind = stringOrUndefined(payload.kind);

  if (artifactId === undefined || revision === undefined || kind === undefined)
    return undefined;

  return {
    artifactId,
    revision,
    kind,
    title: stringOrUndefined(payload.title),
  };
};

interface RevisedPayload {
  readonly artifactId: string;
  readonly revision: number;
}

const revisedOf = (event: PreviewLogEvent): RevisedPayload | undefined => {
  const payload = record(event.event);

  const artifactId = stringOrUndefined(payload?.artifactId);
  const revision = positiveInt(payload?.revision);

  return artifactId !== undefined && revision !== undefined
    ? { artifactId, revision }
    : undefined;
};

const approvedOf = (event: PreviewLogEvent): RevisedPayload | undefined => {
  // `artifacts.approved/v1` carries the same identifying pair as `revised`.
  return revisedOf(event);
};

const PREVIEW_KIND = 'preview';

const setRevision = (
  state: PreviewState | undefined,
  artifactId: string,
  next: PreviewRevisionState,
): PreviewState => {
  const previous = state?.revisions ?? [];
  const revisions = [
    ...previous.filter((item) => item.revision !== next.revision),
    next,
  ].sort((a, b) => a.revision - b.revision);

  return {
    artifactId,
    kind: 'preview',
    ...(state?.title === undefined && next.title === undefined
      ? {}
      : { title: state?.title ?? next.title }),
    revisions,
    latest: revisions[revisions.length - 1]?.revision ?? next.revision,
  };
};

/**
 * Applies one log event. A `created` or `revised` of a `preview` artifact adds
 * a revision (and is the change the projector turns into a block); an
 * `approved` marks its revision; any other kind, and any event that names
 * nothing, changes nothing — this bundle claims only its own kind.
 */
export const applyPreviewEvent = (
  states: PreviewStates,
  event: PreviewLogEvent,
): { readonly states: PreviewStates; readonly change?: PreviewEventChange } => {
  switch (event.type) {
    case 'artifacts.created/v1': {
      const created = createdOf(event);

      if (created === undefined || created.kind !== PREVIEW_KIND)
        return { states };

      const next = setRevision(
        states.get(created.artifactId),
        created.artifactId,
        {
          revision: created.revision,
          ...(created.title === undefined ? {} : { title: created.title }),
          approved: false,
        },
      );

      const nextStates = new Map(states);
      nextStates.set(created.artifactId, next);

      return {
        states: nextStates,
        change: { artifactId: created.artifactId, revision: created.revision },
      };
    }

    case 'artifacts.revised/v1': {
      const revised = revisedOf(event);
      const known =
        revised === undefined ? undefined : states.get(revised.artifactId);

      // A revision of a kind this bundle does not own never enters.
      if (revised === undefined || known === undefined) return { states };

      const next = setRevision(known, revised.artifactId, {
        revision: revised.revision,
        approved: false,
      });

      const nextStates = new Map(states);
      nextStates.set(revised.artifactId, next);

      return {
        states: nextStates,
        change: {
          artifactId: revised.artifactId,
          revision: revised.revision,
        },
      };
    }

    case 'artifacts.approved/v1': {
      const approved = approvedOf(event);
      const known =
        approved === undefined ? undefined : states.get(approved.artifactId);

      if (approved === undefined || known === undefined) return { states };

      const revisions = known.revisions.map((item) =>
        item.revision === approved.revision
          ? { ...item, approved: true }
          : item,
      );
      const nextStates = new Map(states);
      nextStates.set(approved.artifactId, { ...known, revisions });

      return { states: nextStates };
    }

    default:
      return { states };
  }
};

/**
 * The window's first read: the registry's record resolved into the same
 * `PreviewState` the log's events would produce.
 */
export const previewStateOfRecord = (
  value: ArtifactRecord,
): PreviewState | undefined => {
  if (value.kind !== PREVIEW_KIND) return undefined;

  const revisions: PreviewRevisionState[] = [];
  for (let revision = 1; revision <= value.revisions; revision += 1) {
    revisions.push({
      revision,
      ...(revision === value.revision && value.title !== ''
        ? { title: value.title }
        : {}),
      approved: revision === value.revision && value.state === 'approved',
    });
  }

  return {
    artifactId: value.artifactId,
    kind: 'preview',
    ...(value.title === '' ? {} : { title: value.title }),
    revisions,
    latest: value.revision,
  };
};

/* Comments ------------------------------------------------------------------ */

/** One durable comment on a preview, as the `comments.added/v1` event states it. */
export interface PreviewComment {
  readonly commentId: string;
  readonly text: string;
  readonly author?: string;
  readonly revision?: number;
  readonly anchor?: CommentAnchor;
}

const commentOf = (event: PreviewLogEvent): PreviewComment | undefined => {
  const payload = record(event.event);

  if (payload === undefined) return undefined;

  const commentId = stringOrUndefined(payload.commentId);
  const text = typeof payload.text === 'string' ? payload.text : undefined;

  if (commentId === undefined || text === undefined) return undefined;

  const target = record(payload.target);
  const anchor = record(target?.anchor) as CommentAnchor | undefined;

  return {
    commentId,
    text,
    ...(stringOrUndefined(payload.author) === undefined
      ? {}
      : { author: stringOrUndefined(payload.author) }),
    ...(positiveInt(target?.revision) === undefined
      ? {}
      : { revision: positiveInt(target?.revision) }),
    ...(anchor === undefined ? {} : { anchor }),
  };
};

/**
 * Reads the durable comments of one revision off the `comments.added/v1`
 * events of the log, in order. The comment is the other registry's event; this
 * reducer only interprets what targets the preview.
 */
export const commentsOfEvents = (
  events: readonly PreviewLogEvent[],
  artifactId: string,
  revision?: number,
): readonly PreviewComment[] => {
  const comments: PreviewComment[] = [];

  for (const event of events) {
    if (event.type !== 'comments.added/v1') continue;

    const comment = commentOf(event);
    const target = record(record(event.event)?.target);

    if (
      comment === undefined ||
      stringOrUndefined(target?.id) !== artifactId ||
      (revision !== undefined && comment.revision !== revision)
    ) {
      continue;
    }

    comments.push(comment);
  }

  return comments;
};
