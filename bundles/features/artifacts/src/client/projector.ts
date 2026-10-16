// The chat projector of `artifacts.*`: one `artifacts.frame/v1` block per
// revision — the registry's frame, whatever the kind — with the block data a
// frame reads, taken from the one reducer's state: which revision, of which
// artifact, of which kind and titled how (as `created` named them, so a
// revision's frame knows them too), with the revision's anchors and entries.
//
// It also claims `artifacts.approved/v1` and `artifacts.applied/v1`, so they
// fold into the same state instead of falling to the conversation's generic
// block; neither draws a block of its own (a block, once drawn, is not
// redrawn — the frame reads the review state from the registry).
//
// An artifact whose kind nobody knows still becomes a frame block: the frame
// shows what the log names, with no body — the orphan of
// `docs/architecture/bundles/events-and-nodes.md`.

import type { ArtifactEntry, ArtifactTarget } from '../contracts/index.js';
import type {
  ChatBlock,
  ChatThreadEvent,
  ProjectorSpec,
} from './chat-contract.js';
import {
  type ArtifactsProjectionState,
  initialArtifactsState,
  reduceArtifactEvent,
} from './reduce.js';

/** The chat block type of the registry's frame. */
export const ARTIFACT_FRAME_BLOCK_TYPE = 'artifacts.frame/v1';

/** Every event type of the registry, as its full projector claims them. */
export const ARTIFACT_EVENT_TYPES: readonly string[] = [
  'artifacts.created/v1',
  'artifacts.revised/v1',
  'artifacts.approved/v1',
  'artifacts.applied/v1',
];

/** The review pair alone, for a window where a legacy kind projects the rest. */
export const ARTIFACT_REVIEW_EVENT_TYPES: readonly string[] = [
  'artifacts.approved/v1',
  'artifacts.applied/v1',
];

/** The `data` one frame block carries: which revision, and what it named. */
export interface ArtifactFrameData {
  readonly artifactId: string;
  readonly revision: number;
  readonly kind: string;
  readonly title: string;
  /** The revision's anchors and entries, as the event recorded them. */
  readonly targets: readonly ArtifactTarget[];
  readonly entries: readonly ArtifactEntry[];
  readonly changeNote?: string;
  readonly createdAt: string;
  /**
   * The Project and Thread whose log holds the revision: the scope the frame
   * reads the registry and the comments under.
   */
  readonly projectId?: string;
  readonly threadId?: string;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * The frame data of one created or revised event, read from the state the
 * reducer folded it into; undefined when the state holds no such revision.
 */
export const frameDataOf = (
  state: ArtifactsProjectionState,
  event: ChatThreadEvent,
): ArtifactFrameData | undefined => {
  const payload = asRecord(event.event);
  const artifactId = payload?.artifactId;
  const artifact =
    typeof artifactId === 'string'
      ? state.artifacts.get(artifactId)
      : undefined;
  const revision = artifact?.revisions.find(
    (entry) => entry.revision === payload?.revision,
  );

  if (artifact === undefined || revision === undefined) return undefined;

  return {
    artifactId: artifact.artifactId,
    revision: revision.revision,
    kind: artifact.kind,
    title: artifact.title,
    targets: revision.targets,
    entries: revision.entries,
    ...(revision.changeNote === undefined
      ? {}
      : { changeNote: revision.changeNote }),
    createdAt: revision.createdAt,
    projectId: event.projectId,
    threadId: event.threadId,
  };
};

/** The frame block one revision's event draws. */
const frameBlockOf = (
  event: ChatThreadEvent,
  data: ArtifactFrameData,
): ChatBlock => ({
  id: `artifacts.frame:${data.artifactId}@${data.revision}`,
  type: ARTIFACT_FRAME_BLOCK_TYPE,
  promptId: event.promptId,
  sequence: event.sequence,
  data,
});

/**
 * The artifacts bundle's projector, over the one reducer: the state is the
 * projection, so the same fold serves the node, the window and the list.
 * `eventTypes` narrows what it claims (the review pair alone, beside a legacy
 * kind that projects created/revised itself).
 */
export const createArtifactsProjector = (
  eventTypes: readonly string[] = ARTIFACT_EVENT_TYPES,
): ProjectorSpec<ArtifactsProjectionState> => ({
  eventTypes,
  initial: initialArtifactsState,
  reduce: (state, event) => {
    const next = reduceArtifactEvent(state, event);
    const draws =
      event.type === 'artifacts.created/v1' ||
      event.type === 'artifacts.revised/v1';

    // A refused event leaves the state as it was: nothing to stand behind.
    if (!draws || next === state) return { state: next, blocks: [] };

    const data = frameDataOf(next, event);

    return {
      state: next,
      blocks: data === undefined ? [] : [frameBlockOf(event, data)],
    };
  },
});
