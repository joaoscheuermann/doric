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
//
// It also reads the preview's comments off the `comments.*` events — who wrote
// each, the root it answers, whether it was resolved and the prompt it was
// written under — and groups them into threads: a root and its replies, `done`
// once resolved, `await` while the agent spoke last, `open` otherwise.

import {
  type CanvasComment,
  type CanvasLogEvent,
  type CanvasThread,
  commentsOfEvents as canvasCommentsOfEvents,
  threadsOf as canvasThreadsOf,
} from 'desktop/ui/canvas';

import type { ArtifactRecord, CommentAnchor } from '../../contracts/index.js';

/** One event of a Thread's durable log, as any consumer reads it. */
export type PreviewLogEvent = CanvasLogEvent;

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
      // Without a `created` in this log (another Thread created it), the
      // revision's own kind says whether it is a preview.
      const created = known === undefined ? createdOf(event) : undefined;

      // A revision of a kind this bundle does not own never enters.
      if (
        revised === undefined ||
        (known === undefined && created?.kind !== PREVIEW_KIND)
      )
        return { states };

      const next = setRevision(known, revised.artifactId, {
        revision: revised.revision,
        ...(created?.title === undefined ? {} : { title: created.title }),
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

/* Comments and threads ------------------------------------------------------ */

/** One durable comment on a preview, as the `comments.*` events state it. */
export type PreviewComment = CanvasComment<CommentAnchor>;

/** One root comment of a preview and the replies that answer it. */
export type PreviewThread = CanvasThread<CommentAnchor>;

export {
  AGENT_AUTHOR,
  type ThreadState,
  threadStateOf,
} from 'desktop/ui/canvas';

/** The durable comments of a preview, read off the log (see `desktop/ui/canvas`). */
export const commentsOfEvents: (
  events: readonly PreviewLogEvent[],
  artifactId: string,
) => readonly PreviewComment[] = canvasCommentsOfEvents;

/** The preview's comments grouped into threads (see `desktop/ui/canvas`). */
export const threadsOf: (
  comments: readonly PreviewComment[],
) => readonly PreviewThread[] = canvasThreadsOf;
