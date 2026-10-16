// The chat projector of `artifacts.created/v1` and `artifacts.revised/v1`: a
// `papercraft.preview/v1` block per revision of a `preview` artifact (spec:
// "Replay e rewind"). It is the same `domain/preview-state.ts` reducer the
// canvas window reads events through, so the conversation and the window
// reconstruct the same durable state. It is pure: replay and rewind run it
// again over the same event list.
//
// The projector claims the two event types so previews become blocks, and
// ignores every payload whose kind is not `preview`: another artifact kind's
// projector (the `artifacts` bundle's own frame) owns those, and this one
// never claims them.

import { type ArtifactTarget, PREVIEW_BLOCK_TYPE } from '../contracts/index.js';
import type {
  ChatBlock,
  ChatThreadEvent,
  ProjectorSpec,
} from './chat-contract.js';
import {
  applyPreviewEvent,
  initialPreviewStates,
  type PreviewLogEvent,
  type PreviewStates,
} from './domain/preview-state.js';

/** One entry a revision named, as the event carries it: identity, no bytes. */
export interface PreviewBlockEntry {
  readonly path: string;
  readonly sha256: string;
}

/**
 * The `data` one preview block carries: which revision it draws, and the
 * anchors and entries the revision's own event named — the log is the durable
 * truth, so the block reaches the node with the identity the event recorded,
 * and the canvas reads the markup through `papercraft.previews/v1.read`.
 */
export interface PreviewBlockData {
  readonly artifactId: string;
  readonly revision: number;
  readonly kind: 'preview';
  readonly title?: string;
  readonly targets?: readonly ArtifactTarget[];
  readonly entries?: readonly PreviewBlockEntry[];
}

/** The `data` chat hands the `<papercraft-preview>` element through `block`. */
export interface PreviewElementBlock {
  readonly id: string;
  readonly type: string;
  readonly data: PreviewBlockData;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;

const positiveInt = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : undefined;

const titleOf = (
  state: PreviewStates,
  artifactId: string,
): string | undefined => state.get(artifactId)?.title;

/** The entries of an event's payload, when every one names a path and a hash. */
const entriesOf = (
  payload: unknown,
): readonly PreviewBlockEntry[] | undefined => {
  const list = asRecord(payload)?.entries;

  if (Array.isArray(list) === false) return undefined;

  const entries: PreviewBlockEntry[] = [];

  for (const item of list) {
    const entry = asRecord(item);

    if (
      entry === undefined ||
      typeof entry.path !== 'string' ||
      typeof entry.sha256 !== 'string'
    ) {
      return undefined;
    }

    entries.push({ path: entry.path, sha256: entry.sha256 });
  }

  return entries;
};

/** The anchors of an event's payload, when every one names a path. */
const targetsOf = (payload: unknown): readonly ArtifactTarget[] | undefined => {
  const list = asRecord(payload)?.targets;

  if (Array.isArray(list) === false) return undefined;

  const targets: ArtifactTarget[] = [];

  for (const item of list) {
    const target = asRecord(item);

    if (target === undefined || typeof target.path !== 'string') {
      return undefined;
    }

    targets.push({
      path: target.path,
      ...(typeof target.line === 'number' ? { line: target.line } : {}),
      ...(typeof target.snippet === 'string'
        ? { snippet: target.snippet }
        : {}),
    });
  }

  return targets;
};

const blockOf = (
  event: ChatThreadEvent,
  artifactId: string,
  revision: number,
  title: string | undefined,
): ChatBlock => {
  const targets = targetsOf(event.event);
  const entries = entriesOf(event.event);

  return {
    id: `papercraft.preview:${artifactId}@${revision}`,
    type: PREVIEW_BLOCK_TYPE,
    promptId: event.promptId,
    sequence: event.sequence,
    data: {
      artifactId,
      revision,
      kind: 'preview',
      ...(title === undefined ? {} : { title }),
      ...(targets === undefined ? {} : { targets }),
      ...(entries === undefined ? {} : { entries }),
    } satisfies PreviewBlockData,
  };
};

const asLogEvent = (event: ChatThreadEvent): PreviewLogEvent => ({
  type: event.type,
  event: event.event,
});

/**
 * The projector: one block per revision of a `preview` artifact. Old revisions
 * stay in the conversation with their own nodes — replay reconstructs every
 * block in sequence order.
 */
export const createPreviewProjector = (): ProjectorSpec<PreviewStates> => ({
  eventTypes: ['artifacts.created/v1', 'artifacts.revised/v1'],
  initial: initialPreviewStates,
  reduce: (state, event) => {
    const { states, change } = applyPreviewEvent(state, asLogEvent(event));

    if (change === undefined) return { state: states, blocks: [] };

    return {
      state: states,
      blocks: [
        blockOf(
          event,
          change.artifactId,
          change.revision,
          titleOf(states, change.artifactId),
        ),
      ],
    };
  },
});

/** Reads the preview data off a block chat hands an element, else undefined. */
export const previewBlockDataOf = (
  block: unknown,
): PreviewBlockData | undefined => {
  const value = asRecord(block);
  const data = asRecord(value?.data);
  if (data === undefined) return undefined;

  const artifactId = data.artifactId;
  const revision = positiveInt(data.revision);

  if (
    typeof artifactId !== 'string' ||
    artifactId === '' ||
    revision === undefined
  ) {
    return undefined;
  }

  const targets = targetsOf(data);
  const entries = entriesOf(data);

  return {
    artifactId,
    revision,
    kind: 'preview',
    ...(typeof data.title === 'string' ? { title: data.title } : {}),
    ...(targets === undefined ? {} : { targets }),
    ...(entries === undefined ? {} : { entries }),
  };
};
