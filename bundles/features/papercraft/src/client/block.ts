// The block the preview body receives: the registry's frame creates
// `<papercraft-preview>` (the kind's `bodyTag`) inside itself with its own
// block — `type` set to the kind's `blockType` (`papercraft.preview/v1`) and
// `data` the frame's data (`ArtifactFrameData`: the artifact, the revision, the
// anchors and entries the revision's event named, and the Project and Thread
// whose log holds it). "The frame is the registry's, the body is the kind's":
// the `artifacts` bundle projects `artifacts.*` into frames, and this bundle
// only reads the block it is handed.

import type { ArtifactTarget } from '../contracts/index.js';

/** One entry a revision named, as the event carries it: identity, no bytes. */
export interface PreviewBlockEntry {
  readonly path: string;
  readonly sha256: string;
}

/**
 * What the body reads of the frame's data: which revision it draws, the
 * anchors and entries the revision's event named, and the scope it reads the
 * markup through `papercraft.previews/v1.read` in.
 */
export interface PreviewBlockData {
  /** The Project and the Thread whose log the revision's event came from. */
  readonly projectId?: string;
  readonly threadId?: string;
  readonly artifactId: string;
  readonly revision: number;
  readonly kind: 'preview';
  readonly title?: string;
  readonly targets?: readonly ArtifactTarget[];
  readonly entries?: readonly PreviewBlockEntry[];
}

/** The block the frame hands the `<papercraft-preview>` body. */
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
      ...(Array.isArray(target.lines) &&
      target.lines.length === 2 &&
      target.lines.every((line) => typeof line === 'number')
        ? { lines: [target.lines[0], target.lines[1]] as [number, number] }
        : {}),
      ...(typeof target.snippet === 'string'
        ? { snippet: target.snippet }
        : {}),
    });
  }

  return targets;
};

/** Reads the preview data off the block the frame hands the body, else undefined. */
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
    ...(typeof data.projectId === 'string' && data.projectId !== ''
      ? { projectId: data.projectId }
      : {}),
    ...(typeof data.threadId === 'string' && data.threadId !== ''
      ? { threadId: data.threadId }
      : {}),
    artifactId,
    revision,
    kind: 'preview',
    ...(typeof data.title === 'string' ? { title: data.title } : {}),
    ...(targets === undefined ? {} : { targets }),
    ...(entries === undefined ? {} : { entries }),
  };
};
