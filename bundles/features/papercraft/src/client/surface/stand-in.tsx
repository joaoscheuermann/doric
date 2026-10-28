// `stand-in.tsx` — what a preview draws where no live frame shows it
// (isolamento.md, "Virtualização"): its snapshot, at the content size the
// picture covers, else a placeholder with the preview's size and title. The
// canvas keeps drawing the pins, outlines and comments over it from the last
// scene the frame reported (`frame-memory.ts`).
//
// Over a live frame that has not rendered yet (a promotion, a frame that does
// not answer), the stand-in lies on top of the iframe, so the reader never
// sees the preview flash empty.

import { cn } from 'desktop/ui/utils';

import type { StoredSnapshot } from './snapshots.js';

export interface StandInProps {
  /** The picture of the revision, when one was taken in this theme and width. */
  readonly snapshot: StoredSnapshot | undefined;
  /** The placeholder's size, in content pixels, when there is no picture. */
  readonly width: number | undefined;
  readonly height: number | undefined;
  /** The preview's name, which the placeholder shows. */
  readonly title: string | undefined;
  /** Lies over a live frame that has not rendered yet. */
  readonly over: boolean;
}

const px = (value: number | undefined): string | undefined =>
  value === undefined ? undefined : `${String(value)}px`;

export function StandIn({
  snapshot,
  width,
  height,
  title,
  over,
}: StandInProps) {
  const position = over ? 'absolute top-0 left-0 z-[1]' : 'relative';

  if (snapshot !== undefined) {
    return (
      <img
        data-testid="papercraft-snapshot"
        className={cn('papercraft-snapshot block select-none', position)}
        src={snapshot.src}
        alt={title ?? ''}
        draggable={false}
        style={{ width: px(snapshot.width), height: px(snapshot.height) }}
      />
    );
  }

  return (
    <div
      data-testid="papercraft-placeholder"
      className={cn(
        'papercraft-placeholder flex items-center justify-center rounded-md border border-dashed border-border bg-muted/40 p-4 text-xs text-muted-foreground',
        position,
      )}
      // A preview that never reported its size takes a modest box.
      style={{ width: px(width) ?? '16rem', height: px(height) ?? '8rem' }}
    >
      <span className="truncate">{title ?? 'preview'}</span>
    </div>
  );
}
