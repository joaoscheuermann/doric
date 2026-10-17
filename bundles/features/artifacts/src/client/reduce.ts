// The one reducer of `artifacts/v1`: one state per artifact — the revisions it
// gained in log order, the current one, the review state, and the comments
// still pending on it. The same reducer serves the node and the window, as
// `docs/architecture/bundles/artifacts.md` demands; it is pure, so replay and
// rewind run it again over the same event list.
//
// The comment counts come from the comments registry's own events — a comment
// on an artifact is a `comments.added/v1` whose target is the revision —
// exactly as the docs state the relation: two streams, one target. A comment
// without a revision anchors to no revision and counts nowhere.

import type { ArtifactEntry, ArtifactTarget } from '../contracts/index.js';
import { ARTIFACT_TARGET_KIND } from '../contracts/index.js';
import type { ChatThreadEvent } from './chat-contract.js';

/** One revision as the projection keeps it. */
export interface ArtifactRevisionProjection {
  readonly revision: number;
  readonly targets: readonly ArtifactTarget[];
  readonly entries: readonly ArtifactEntry[];
  readonly changeNote?: string;
  readonly createdAt: string;
  /** Comments on this revision that nobody has resolved yet. */
  readonly pendingComments: number;
  readonly approved: boolean;
  readonly applied: boolean;
}

/** One artifact as the projection keeps it: every revision, in log order. */
export interface ArtifactProjection {
  readonly artifactId: string;
  readonly kind: string;
  readonly title: string;
  /** Every revision in log order; a revision is immutable. */
  readonly revisions: readonly ArtifactRevisionProjection[];
  /** The newest revision. */
  readonly revision: number;
  /** The review state of the newest revision: a new revision starts open. */
  readonly state: 'open' | 'approved';
  /** The newest revision that was approved, when any was. */
  readonly approvedRevision?: number;
  readonly createdAt: string;
  /** The comments still pending over the whole artifact. */
  readonly pendingComments: number;
}

/** What comment a target names, as the reducer counts it. */
interface CommentRef {
  readonly artifactId: string;
  readonly revision: number;
}

/** The state the reducer folds: one projection per artifact. */
export interface ArtifactsProjectionState {
  readonly artifacts: ReadonlyMap<string, ArtifactProjection>;
  /** commentId → the artifact revision it was anchored to. */
  readonly comments: ReadonlyMap<string, CommentRef>;
  /** The comment ids already resolved, as the log resolved them. */
  readonly resolved: ReadonlySet<string>;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : undefined;

const targetsOf = (value: unknown): readonly ArtifactTarget[] =>
  Array.isArray(value)
    ? value.filter(
        (entry) =>
          asRecord(entry) !== undefined &&
          typeof entry.path === 'string' &&
          entry.path.length > 0,
      )
    : [];

const entriesOf = (value: unknown): readonly ArtifactEntry[] =>
  Array.isArray(value)
    ? value.filter(
        (entry) =>
          asRecord(entry) !== undefined &&
          typeof entry.path === 'string' &&
          entry.path.length > 0 &&
          typeof entry.sha256 === 'string' &&
          entry.sha256.length > 0,
      )
    : [];

/** A state without the keys whose value is `undefined`: absent stays absent. */
const definedFields = <T extends object>(value: T): T =>
  Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;

const withRevision = (
  artifact: ArtifactProjection,
  revision: ArtifactRevisionProjection,
  pending: number,
): ArtifactProjection => ({
  ...artifact,
  revisions: [...artifact.revisions, revision],
  revision: revision.revision,
  pendingComments: artifact.pendingComments + pending,
});

const adjustPending = (
  state: ArtifactsProjectionState,
  commentId: string,
  delta: number,
): ArtifactsProjectionState => {
  const ref = state.comments.get(commentId);

  if (ref === undefined) return state;

  const artifact = state.artifacts.get(ref.artifactId);

  if (artifact === undefined) return state;

  const revisions = artifact.revisions.map((entry) =>
    entry.revision === ref.revision
      ? { ...entry, pendingComments: entry.pendingComments + delta }
      : entry,
  );
  const artifacts = new Map(state.artifacts);
  artifacts.set(ref.artifactId, {
    ...artifact,
    revisions,
    pendingComments: artifact.pendingComments + delta,
  });

  return { ...state, artifacts };
};

/** The initial state, as a projector folds from the first event. */
export const initialArtifactsState = (): ArtifactsProjectionState => ({
  artifacts: new Map<string, ArtifactProjection>(),
  comments: new Map<string, CommentRef>(),
  resolved: new Set<string>(),
});

/**
 * Reduces one `artifacts.created/v1` event. The first revision of an
 * artifact carries its anchors and entries; a repeat for an artifact the
 * state already knows changes nothing, as the log replays.
 */
const reduceCreated = (
  state: ArtifactsProjectionState,
  event: ChatThreadEvent,
): ArtifactsProjectionState => {
  const payload = asRecord(event.event);

  if (payload === undefined) return state;

  const artifactId = text(payload.artifactId);
  const revision = count(payload.revision);
  const kind = text(payload.kind);
  const title = text(payload.title);

  if (
    artifactId === undefined ||
    revision !== 1 ||
    kind === undefined ||
    title === undefined
  ) {
    return state;
  }

  if (state.artifacts.has(artifactId)) return state;

  const artifacts = new Map(state.artifacts);

  artifacts.set(artifactId, {
    artifactId,
    kind,
    title,
    revisions: [
      {
        revision: 1,
        targets: targetsOf(payload.targets),
        entries: entriesOf(payload.entries),
        createdAt: event.createdAt,
        pendingComments: 0,
        approved: false,
        applied: false,
      },
    ],
    revision: 1,
    state: 'open',
    createdAt: event.createdAt,
    pendingComments: 0,
  });

  return { ...state, artifacts };
};

/**
 * Reduces one `artifacts.revised/v1` event: a newer revision, appended. Other
 * Threads may revise the same artifact, so this log can skip revisions, or
 * hold no `created` at all: then the event's own kind and title start it.
 */
const reduceRevised = (
  state: ArtifactsProjectionState,
  event: ChatThreadEvent,
): ArtifactsProjectionState => {
  const payload = asRecord(event.event);

  if (payload === undefined) return state;

  const artifactId = text(payload.artifactId);
  const revision = count(payload.revision);

  if (artifactId === undefined || revision === undefined) return state;

  const known = state.artifacts.get(artifactId);
  const kind = text(payload.kind);
  const title = text(payload.title);
  const artifact: ArtifactProjection | undefined =
    known ??
    (kind === undefined || title === undefined
      ? undefined
      : {
          artifactId,
          kind,
          title,
          revisions: [],
          revision: 0,
          state: 'open',
          createdAt: event.createdAt,
          pendingComments: 0,
        });

  if (artifact === undefined || revision <= artifact.revision) {
    return state;
  }

  const revisionState: ArtifactRevisionProjection = {
    revision,
    // The revised event carries the revision's resolved anchors and entries —
    // the log is the durable truth, so no carry-over needs the work copy.
    targets: targetsOf(payload.targets),
    entries: entriesOf(payload.entries),
    changeNote: text(payload.changeNote),
    createdAt: event.createdAt,
    pendingComments: 0,
    approved: false,
    applied: false,
  };
  const artifacts = new Map(state.artifacts);

  artifacts.set(artifactId, {
    ...withRevision(artifact, revisionState, 0),
    state: 'open',
  });

  return { ...state, artifacts };
};

/** Reduces one `artifacts.approved/v1` event: the review gesture. */
const reduceApproved = (
  state: ArtifactsProjectionState,
  event: ChatThreadEvent,
): ArtifactsProjectionState => {
  const payload = asRecord(event.event);

  if (payload === undefined) return state;

  const artifactId = text(payload.artifactId);
  const revision = count(payload.revision);

  if (artifactId === undefined || revision === undefined) return state;

  const artifact = state.artifacts.get(artifactId);

  if (artifact === undefined) return state;

  const approved = artifact.revisions.find(
    (entry) => entry.revision === revision,
  );

  // One approval per revision, and only of a revision the artifact has.
  if (approved === undefined || approved.approved) return state;

  const artifacts = new Map(state.artifacts);
  artifacts.set(artifactId, {
    ...artifact,
    state: revision === artifact.revision ? 'approved' : artifact.state,
    approvedRevision: Math.max(artifact.approvedRevision ?? 0, revision),
    revisions: artifact.revisions.map((entry) =>
      entry.revision === revision ? { ...entry, approved: true } : entry,
    ),
  });

  return { ...state, artifacts };
};

/** Reduces one `artifacts.applied/v1` event: the revision reached the code. */
const reduceApplied = (
  state: ArtifactsProjectionState,
  event: ChatThreadEvent,
): ArtifactsProjectionState => {
  const payload = asRecord(event.event);

  if (payload === undefined) return state;

  const artifactId = text(payload.artifactId);
  const revision = count(payload.revision);

  if (artifactId === undefined || revision === undefined) return state;

  const artifact = state.artifacts.get(artifactId);

  if (artifact === undefined) return state;

  const artifacts = new Map(state.artifacts);
  artifacts.set(artifactId, {
    ...artifact,
    revisions: artifact.revisions.map((entry) =>
      entry.revision === revision && !entry.applied
        ? { ...entry, applied: true }
        : entry,
    ),
  });

  return { ...state, artifacts };
};

/** Reduces one `comments.added/v1` event anchored to an artifact revision. */
const reduceCommentAdded = (
  state: ArtifactsProjectionState,
  event: ChatThreadEvent,
): ArtifactsProjectionState => {
  const payload = asRecord(event.event);

  if (payload === undefined) return state;

  const commentId = text(payload.commentId);
  const target = asRecord(payload.target);

  if (commentId === undefined || target === undefined) return state;

  // Only a comment on an artifact revision counts: the anchor is the
  // target's own, and the comments registry never looks inside it.
  if (target.kind !== ARTIFACT_TARGET_KIND) return state;

  const artifactId = text(target.id);
  const revision = count(target.revision);

  if (artifactId === undefined || revision === undefined) return state;

  if (state.comments.has(commentId)) return state;

  const artifact = state.artifacts.get(artifactId);

  if (artifact === undefined) return state;

  if (!artifact.revisions.some((entry) => entry.revision === revision)) {
    return state;
  }

  const comments = new Map(state.comments);

  comments.set(commentId, { artifactId, revision });

  return adjustPending(
    { ...state, comments },
    commentId,
    state.resolved.has(commentId) ? 0 : 1,
  );
};

/**
 * Reduces one `comments.resolved/v1` event: the count follows the state, so
 * resolving twice changes nothing and reopening counts again.
 */
const reduceCommentResolved = (
  state: ArtifactsProjectionState,
  event: ChatThreadEvent,
): ArtifactsProjectionState => {
  const payload = asRecord(event.event);

  if (payload === undefined) return state;

  const commentId = text(payload.commentId);

  if (commentId === undefined || !state.comments.has(commentId)) {
    return state;
  }

  const resolved = payload.resolved === true;
  const resolvedState = new Set(state.resolved);

  if (resolved) resolvedState.add(commentId);
  else resolvedState.delete(commentId);

  if (resolvedState.size === state.resolved.size) return state;

  const next: ArtifactsProjectionState = {
    ...state,
    resolved: resolvedState,
  };

  return adjustPending(next, commentId, resolved ? -1 : 1);
};

/**
 * Folds one Thread event into the projection. Unknown or malformed events
 * change nothing: the log may hold streams this reducer does not claim.
 */
export const reduceArtifactEvent = (
  state: ArtifactsProjectionState,
  event: ChatThreadEvent,
): ArtifactsProjectionState => {
  switch (event.type) {
    case 'artifacts.created/v1':
      return reduceCreated(state, event);
    case 'artifacts.revised/v1':
      return reduceRevised(state, event);
    case 'artifacts.approved/v1':
      return reduceApproved(state, event);
    case 'artifacts.applied/v1':
      return reduceApplied(state, event);
    case 'comments.added/v1':
      return reduceCommentAdded(state, event);
    case 'comments.resolved/v1':
      return reduceCommentResolved(state, event);
    default:
      return state;
  }
};

/** Folds a whole event list, in order, from the initial state. */
export const reduceArtifacts = (
  events: readonly ChatThreadEvent[],
  state: ArtifactsProjectionState = initialArtifactsState(),
): ArtifactsProjectionState =>
  events.reduce((folded, event) => reduceArtifactEvent(folded, event), state);

/** What one artifact's projection looks like as JSON, for readers of the state. */
export const projectionOf = (artifact: ArtifactProjection) =>
  definedFields({
    artifactId: artifact.artifactId,
    kind: artifact.kind,
    title: artifact.title,
    revision: artifact.revision,
    revisions: artifact.revisions.length,
    state: artifact.state,
    approvedRevision: artifact.approvedRevision,
    pendingComments: artifact.pendingComments,
  });
