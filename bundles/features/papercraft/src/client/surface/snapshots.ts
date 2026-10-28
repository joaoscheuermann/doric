// `snapshots.ts` — the pictures a dead preview draws instead of its frame
// (isolamento.md, "Virtualização" and "O snapshot").
//
// When a live frame is stable on screen — it said it mounted, its scene has
// not changed for `SNAPSHOT_SETTLE_MS`, its iframe has not moved between two
// readings that far apart, it lies wholly inside the window's viewport with
// nothing of the page over it, no layer is hidden and the canvas is not
// mid-gesture — the window captures the iframe's rectangle through
// `papercraft.snapshot/v1`. The canvas's own drawings over the preview (the
// header, the pins, the outlines) are concealed for that capture, so the
// picture holds the preview alone and a dead frame draws them again on top.
//
// A revision is immutable, so a picture stays good for as long as the reader's
// theme and the frame's width are the ones it was taken at: the cache is keyed
// by artifact, revision, theme and width, kept in memory and bounded (the
// least recently drawn is forgotten first). The picture is taken at the
// on-screen scale (the canvas's zoom); it is drawn at the content size it
// covered. A capture that fails (`unavailable`, a closed window, a rectangle
// main refuses) is silent: the preview keeps its placeholder.

import { type RefObject, useCallback, useEffect, useRef } from 'react';

import {
  SNAPSHOT_MAX_SIDE,
  type Snapshot,
  type SnapshotRect,
} from '../../contracts/index.js';
import type { PreviewTheme } from '../frame-protocol.js';

/** What a picture is good for: one revision, in one theme, at one width. */
export interface SnapshotKey {
  readonly artifactId: string;
  readonly revision: number;
  readonly theme: PreviewTheme;
  /** The iframe's width, in content pixels. */
  readonly width: number;
}

/** A picture kept for a dead frame, and the content size it covers. */
export interface StoredSnapshot {
  /** A `data:` URL of the PNG. */
  readonly src: string;
  readonly width: number;
  readonly height: number;
}

/** The most pictures one window keeps. */
export const SNAPSHOT_CACHE_LIMIT = 24;

/** How long a live frame's scene and place must hold before it is captured. */
export const SNAPSHOT_SETTLE_MS = 300;

const cache = new Map<string, StoredSnapshot>();

const cacheKeyOf = (key: SnapshotKey): string =>
  `${key.artifactId}@${String(key.revision)}:${key.theme}:${String(Math.round(key.width))}`;

/** The picture of a revision in a theme and at a width, if one was taken. */
export const snapshotOf = (key: SnapshotKey): StoredSnapshot | undefined => {
  const id = cacheKeyOf(key);
  const found = cache.get(id);

  if (found === undefined) return undefined;

  // Re-inserted, so the map's order is the order of use.
  cache.delete(id);
  cache.set(id, found);

  return found;
};

/** Keeps a picture, forgetting the least recently used past the limit. */
export const keepSnapshot = (key: SnapshotKey, snapshot: StoredSnapshot) => {
  const id = cacheKeyOf(key);

  cache.delete(id);
  cache.set(id, snapshot);

  while (cache.size > SNAPSHOT_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;

    if (oldest === undefined) break;
    cache.delete(oldest);
  }
};

/** How the surface reaches the window's capture, and the canvas around it. */
export interface SurfaceSnapshots {
  /** Captures a rectangle of the window (CSS px of its viewport). */
  readonly capture: (rect: SnapshotRect) => Promise<Snapshot>;
  /** Whether the canvas is mid-gesture (a pan, an open comment): no capture. */
  readonly busy?: () => boolean;
  /** Hides what the canvas draws over the preview; answers the undo. */
  readonly conceal?: () => () => void;
}

/** The live frame to capture: its key and the content height it covers. */
export interface CaptureTarget extends SnapshotKey {
  readonly height: number;
}

const sameTarget = (
  a: CaptureTarget | undefined,
  b: CaptureTarget | undefined,
): boolean =>
  a !== undefined &&
  b !== undefined &&
  cacheKeyOf(a) === cacheKeyOf(b) &&
  a.height === b.height;

const viewportOf = (): { readonly width: number; readonly height: number } => ({
  width:
    typeof window === 'undefined'
      ? 0
      : window.innerWidth || document.documentElement.clientWidth,
  height:
    typeof window === 'undefined'
      ? 0
      : window.innerHeight || document.documentElement.clientHeight,
});

/** The iframe's rectangle when it lies wholly inside the window's viewport. */
const onScreenRectOf = (frame: Element): SnapshotRect | undefined => {
  const box = frame.getBoundingClientRect();
  const viewport = viewportOf();

  if (
    !(box.width > 0 && box.height > 0) ||
    box.width > SNAPSHOT_MAX_SIDE ||
    box.height > SNAPSHOT_MAX_SIDE ||
    box.left < 0 ||
    box.top < 0 ||
    box.left + box.width > viewport.width ||
    box.top + box.height > viewport.height
  ) {
    return undefined;
  }

  return { x: box.left, y: box.top, width: box.width, height: box.height };
};

const rectKeyOf = (rect: SnapshotRect): string =>
  `${String(rect.x)},${String(rect.y)},${String(rect.width)},${String(rect.height)}`;

/**
 * Whether something of the page lies over the rectangle: a clipping
 * ancestor, the conversation's composer. Sampled at its centre and near its
 * corners; a point nothing answers for is not covered.
 */
const covered = (frame: Element, rect: SnapshotRect): boolean => {
  if (typeof document.elementFromPoint !== 'function') return false;

  const inset = Math.min(2, rect.width / 2, rect.height / 2);
  const points: readonly (readonly [number, number])[] = [
    [rect.x + rect.width / 2, rect.y + rect.height / 2],
    [rect.x + inset, rect.y + inset],
    [rect.x + rect.width - inset, rect.y + inset],
    [rect.x + inset, rect.y + rect.height - inset],
    [rect.x + rect.width - inset, rect.y + rect.height - inset],
  ];

  return points.some(([x, y]) => {
    const hit = document.elementFromPoint(x, y);

    return hit !== null && hit !== frame;
  });
};

/** Resolves once the window painted a frame. */
const painted = (): Promise<void> =>
  new Promise((done) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => done());
    } else {
      setTimeout(done, 16);
    }
  });

export interface SnapshotCaptureInput {
  /** The element the live iframe is inside. */
  readonly host: RefObject<HTMLElement | null>;
  /** The live frame to capture; undefined while there is none to take. */
  readonly target: CaptureTarget | undefined;
  readonly snapshots: SurfaceSnapshots | undefined;
}

/**
 * Captures the live frame once it is stable on screen. `sceneChanged` is
 * called on every scene the frame sends: the settle time starts again.
 */
export const useSnapshotCapture = ({
  host,
  target,
  snapshots,
}: SnapshotCaptureInput): { readonly sceneChanged: () => void } => {
  const latest = useRef({ target, snapshots });
  latest.current = { target, snapshots };

  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastRect = useRef<string | undefined>(undefined);
  const inFlight = useRef(false);
  const attempt = useRef<() => void>(() => undefined);

  const schedule = useCallback(() => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = undefined;
      attempt.current();
    }, SNAPSHOT_SETTLE_MS);
  }, []);

  const take = async (
    frame: Element,
    wanted: CaptureTarget,
    through: SurfaceSnapshots,
  ): Promise<void> => {
    inFlight.current = true;

    let undo: (() => void) | undefined;

    try {
      undo = through.conceal?.();

      const rect = onScreenRectOf(frame);

      // Checked with the canvas's drawings hidden: only the page's own
      // elements can cover the preview now.
      if (rect === undefined || covered(frame, rect)) return;

      // The concealment reaches the screen before main reads its pixels.
      await painted();
      await painted();

      const shot = await through.capture(rect);

      if (!sameTarget(latest.current.target, wanted)) return;

      keepSnapshot(wanted, {
        src: `data:image/png;base64,${shot.png}`,
        width: wanted.width,
        height: wanted.height,
      });
    } catch {
      // The capture could not be taken: the placeholder stays.
    } finally {
      undo?.();
      inFlight.current = false;
    }
  };

  attempt.current = () => {
    const { target: wanted, snapshots: through } = latest.current;
    const frame = host.current?.querySelector('iframe');

    if (
      wanted === undefined ||
      through === undefined ||
      frame == null ||
      inFlight.current ||
      snapshotOf(wanted) !== undefined
    ) {
      return;
    }

    if (through.busy?.() === true) {
      lastRect.current = undefined;
      schedule();

      return;
    }

    const rect = onScreenRectOf(frame);

    // Off screen: the observer below tries again once it is wholly in view.
    if (rect === undefined) {
      lastRect.current = undefined;

      return;
    }

    // It must hold its place for a settle time too: a scroll, a pan or a
    // zoom moves it.
    const rectKey = rectKeyOf(rect);

    if (lastRect.current !== rectKey) {
      lastRect.current = rectKey;
      schedule();

      return;
    }

    void take(frame, wanted, through);
  };

  const sceneChanged = useCallback(() => {
    lastRect.current = undefined;
    schedule();
  }, [schedule]);

  const targetKey =
    target === undefined || snapshots === undefined
      ? undefined
      : `${cacheKeyOf(target)}:${String(target.height)}`;

  // A new target (the frame mounted, the theme or the width changed) starts
  // the settle time; so does the frame coming wholly into view.
  useEffect(() => {
    if (targetKey === undefined) return;

    lastRect.current = undefined;
    schedule();

    const frame = host.current?.querySelector('iframe');

    if (frame == null || typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries.at(-1);

        if (entry?.isIntersecting === true && entry.intersectionRatio >= 0.99) {
          lastRect.current = undefined;
          schedule();
        }
      },
      { threshold: [1] },
    );

    observer.observe(frame);

    return () => observer.disconnect();
  }, [targetKey, host, schedule]);

  useEffect(
    () => () => {
      if (timer.current !== undefined) clearTimeout(timer.current);
    },
    [],
  );

  return { sceneChanged };
};
