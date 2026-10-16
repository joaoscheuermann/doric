// The chat projector of `artifacts.created/v1` / `artifacts.revised/v1`: one
// `artifacts.frame/v1` block per revision — the registry's generic frame,
// with the block data a frame reads: which revision, of which artifact and
// kind, titled how, carrying which anchors and entries.
//
// It claims the pair only when no kind bundle owns a node surface of its own:
// a kind that registered a `blockType` in `artifact.kind/v1` has its own
// projector and renderer (as `papercraft`'s client does for `preview`), and
// claiming the same event types would break that bundle's registration — the
// registry's client leaves the pair to it and registers this projector only in
// a window where no such kind exists. An artifact whose kind nobody knows
// still becomes a frame block: the frame shows what the log names, with no
// body renderer active — the orphan of `docs/architecture/bundles/events-and-nodes.md`.

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

/** The chat block type of the registry's generic frame. */
export const ARTIFACT_FRAME_BLOCK_TYPE = 'artifacts.frame/v1';

/** The `data` one frame block carries: which revision, and what it named. */
export interface ArtifactFrameData {
  readonly artifactId: string;
  readonly revision: number;
  readonly kind: string;
  readonly title?: string;
  /** The revision's anchors and entries, as the event recorded them. */
  readonly targets: readonly ArtifactTarget[];
  readonly entries: readonly ArtifactEntry[];
  readonly changeNote?: string;
  readonly createdAt: string;
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

/**
 * The frame data of one created or revised event, or undefined when the
 * payload does not name a revision of an artifact.
 */
export const frameDataOf = (
  event: ChatThreadEvent,
): ArtifactFrameData | undefined => {
  const payload = asRecord(event.event);

  if (payload === undefined) return undefined;

  const artifactId = text(payload.artifactId);
  const revision = count(payload.revision);
  const kind = text(payload.kind);

  if (artifactId === undefined || revision === undefined) return undefined;

  const targets = Array.isArray(payload.targets)
    ? (payload.targets.filter(
        (entry) => asRecord(entry) !== undefined,
      ) as readonly ArtifactTarget[])
    : [];
  const entries = Array.isArray(payload.entries)
    ? (payload.entries.filter(
        (entry) => asRecord(entry) !== undefined,
      ) as readonly ArtifactEntry[])
    : [];

  return {
    artifactId,
    revision,
    // `revised` carries no kind of its own: the frame names the artifact, and
    // the kind its projection carried at `created`.
    kind: kind ?? 'unknown',
    ...(text(payload.title) === undefined
      ? {}
      : { title: text(payload.title) }),
    targets,
    entries,
    ...(text(payload.changeNote) === undefined
      ? {}
      : { changeNote: text(payload.changeNote) }),
    createdAt: event.createdAt,
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
 */
export const createArtifactsProjector =
  (): ProjectorSpec<ArtifactsProjectionState> => ({
    eventTypes: ['artifacts.created/v1', 'artifacts.revised/v1'],
    initial: initialArtifactsState,
    reduce: (state, event) => {
      const next = reduceArtifactEvent(state, event);

      if (
        event.type !== 'artifacts.created/v1' &&
        event.type !== 'artifacts.revised/v1'
      ) {
        return { state: next, blocks: [] };
      }

      const data = frameDataOf(event);

      if (data === undefined) return { state: next, blocks: [] };

      const artifact = next.artifacts.get(data.artifactId);

      if (
        artifact === undefined ||
        !artifact.revisions.some((entry) => entry.revision === data.revision)
      ) {
        // The reducer refused the event (a revision the artifact does not have);
        // the projector draws nothing it cannot stand behind.
        return { state: next, blocks: [] };
      }

      return {
        state: next,
        blocks: [frameBlockOf(event, data)],
      };
    },
  });
