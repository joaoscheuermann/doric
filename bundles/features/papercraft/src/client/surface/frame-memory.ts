// `frame-memory.ts` — what a preview's live frame last reported, per
// (artifact, revision), kept beyond the frame's own life.
//
// A revision is immutable, so the last scene, size, layout and mode its frame
// reported stay good for drawing it again: pins, outlines and comments can
// render over a stand-in (a snapshot, a placeholder) when no frame is live for
// it. The live frame writes here (`preview-surface.tsx`), and a dead preview
// reads it back to draw its stand-in at the size the frame had and to hand
// the canvas its last scene (`live-frames.ts`, `stand-in.tsx`).
//
// The memory is per window and bounded: the oldest revisions are forgotten
// first.

import type {
  FrameMessage,
  PreviewLayout,
  PreviewTheme,
  SceneNodeData,
} from '../frame-protocol.js';
import type { SurfaceMode } from './preview-surface.js';

/** The content size a frame reported. */
export type FrameSize = Pick<
  Extract<FrameMessage, { kind: 'size' }>,
  'width' | 'height'
>;

/** What one revision's frame last reported, and how it was laid out. */
export interface FrameRecord {
  readonly scene?: readonly SceneNodeData[];
  readonly size?: FrameSize;
  readonly mode?: SurfaceMode;
  readonly layout?: PreviewLayout;
  readonly theme?: PreviewTheme;
  /** The iframe's width when the frame reported, in content pixels. */
  readonly width?: number;
}

/** The most revisions one window remembers. */
export const FRAME_MEMORY_LIMIT = 64;

const records = new Map<string, FrameRecord>();

/** The key of one revision's record. */
export const frameKeyOf = (artifactId: string, revision: number): string =>
  `${artifactId}@${String(revision)}`;

/** What the revision's frame last reported, if any frame of it ever did. */
export const lastFrameOf = (
  artifactId: string,
  revision: number,
): FrameRecord | undefined => records.get(frameKeyOf(artifactId, revision));

/** Merges what a frame reported now into its revision's record. */
export const rememberFrame = (
  artifactId: string,
  revision: number,
  patch: FrameRecord,
): void => {
  const key = frameKeyOf(artifactId, revision);
  const next = { ...records.get(key), ...patch };

  // Re-inserted, so the map's order is the order of use.
  records.delete(key);
  records.set(key, next);

  while (records.size > FRAME_MEMORY_LIMIT) {
    const oldest = records.keys().next().value;

    if (oldest === undefined) break;
    records.delete(oldest);
  }
};
