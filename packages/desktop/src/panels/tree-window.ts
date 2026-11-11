// The windowing behind `FileTree`: the open tree flattened into the lines it
// draws, each line's fixed height, and the range of lines that intersect the
// nearest scrolling ancestor's viewport. Only that range (plus overscan and
// any line the tree keeps mounted) becomes DOM, so a tree with tens of
// thousands of rows under open directories costs about one screen of rows.
// Internal to the panels: nothing here is exported from the package.

import { type RefObject, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

import type { TreeNode } from './file-tree.js';

/** One line of the flattened tree, in drawing order. */
export type TreeLine =
  | {
      readonly kind: 'row';
      readonly key: string;
      readonly node: TreeNode;
      readonly depth: number;
      readonly open: boolean;
      /** The row's 1-based position among its siblings, and their count. */
      readonly position: number;
      readonly siblings: number;
    }
  | {
      /** The open directory's pending row (`FileTree.pending`). */
      readonly kind: 'pending';
      readonly key: string;
      readonly depth: number;
    }
  | {
      /** The notice an open directory shows in place of its children. */
      readonly kind: 'empty' | 'loading';
      readonly key: string;
      readonly depth: number;
    };

/**
 * The lines an open tree draws: every row, and under each open directory its
 * pending row (first), then a loading notice when it is loading, else its
 * children, else — with no pending row — the empty-directory notice.
 */
export const flattenTree = (
  entries: readonly TreeNode[],
  depth: number,
  expanded: ReadonlySet<string>,
  pendingDirectory: string | undefined,
  loading: ReadonlySet<string> | undefined,
): readonly TreeLine[] => {
  const lines: TreeLine[] = [];
  const visit = (level: readonly TreeNode[], at: number): void => {
    level.forEach((node, index) => {
      const open = node.type === 'directory' && expanded.has(node.path);
      lines.push({
        kind: 'row',
        key: node.path,
        node,
        depth: at,
        open,
        position: index + 1,
        siblings: level.length,
      });
      if (!open) return;
      const pending = pendingDirectory === node.path;
      if (pending) {
        lines.push({
          kind: 'pending',
          key: `${node.path}\0pending`,
          depth: at + 1,
        });
      }
      const children = node.children ?? [];
      if (loading?.has(node.path) === true) {
        lines.push({
          kind: 'loading',
          key: `${node.path}\0loading`,
          depth: at + 1,
        });
      } else if (children.length > 0) {
        visit(children, at + 1);
      } else if (!pending) {
        lines.push({
          kind: 'empty',
          key: `${node.path}\0empty`,
          depth: at + 1,
        });
      }
    });
  };
  visit(entries, depth);
  return lines;
};

/**
 * Line heights in rem. A row is the 28 px (`h-7`) sidebar button; a notice is
 * one line of `text-xs` with `py-1` (`h-6`). The pending row is laid out as a
 * row; when it grows (an error under its input) the rows after it still flow
 * below it, and only the estimate of the scroll height is off by the growth.
 */
export const rowHeight = 1.75;
export const noticeHeight = 1.5;

const heightOf = (line: TreeLine): number =>
  line.kind === 'empty' || line.kind === 'loading' ? noticeHeight : rowHeight;

/** Each line's top offset in rem; one more entry holds the total height. */
export const lineOffsets = (lines: readonly TreeLine[]): Float64Array => {
  const offsets = new Float64Array(lines.length + 1);
  for (let index = 0; index < lines.length; index += 1) {
    offsets[index + 1] =
      (offsets[index] ?? 0) + heightOf(lines[index] as TreeLine);
  }
  return offsets;
};

/** Lines `first` (inclusive) to `last` (exclusive). */
export type LineRange = { readonly first: number; readonly last: number };

/**
 * Lines drawn beyond each edge of the viewport: half a viewport, and at least
 * this many. The compositor scrolls ahead of the main thread, so a fast fling
 * travels several rows per frame; a margin of only a few rows runs out before
 * the next range is drawn and shows blank space for a frame or two.
 */
const minOverscan = 12;

const overscanFor = (viewportLines: number): number =>
  Math.max(minOverscan, Math.ceil(viewportLines / 2));

/** Lines drawn before the viewport is measured (and in a static render). */
const initialLines = 64;

/** The index of the line that holds `offset`, clamped to the lines. */
const lineAt = (offsets: Float64Array, offset: number): number => {
  const count = offsets.length - 1;
  let low = 0;
  let high = count;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((offsets[middle + 1] ?? 0) <= offset) low = middle + 1;
    else high = middle;
  }
  return Math.min(low, count);
};

/** The part of the window `element` can show, and the box that clips it. */
interface Viewport {
  /** Client-coordinate band, intersected over every clipping ancestor. */
  readonly top: number;
  readonly bottom: number;
  /** The nearest clipping ancestor, if any (else the window clips). */
  readonly container: HTMLElement | undefined;
  /** Whether that box has a height yet: an unlaid-out panel has none. */
  readonly laidOut: boolean;
}

/**
 * Measured at each call, never cached: which ancestor scrolls can change after
 * mount (a scroll area applies its `overflow` once it has measured itself), so
 * a choice made at mount could leave the tree following a box that never
 * scrolls while the one that does goes unheard.
 */
const viewportOf = (element: HTMLElement): Viewport => {
  const document = element.ownerDocument;
  const view = document.defaultView;
  let top = 0;
  let bottom = view?.innerHeight ?? 0;
  let container: HTMLElement | undefined;
  for (
    let current = element.parentElement;
    current !== null && current !== document.documentElement;
    current = current.parentElement
  ) {
    const style = view?.getComputedStyle(current);
    const overflow = style?.overflowY || style?.overflow || 'visible';
    if (overflow === 'visible') continue;
    const box = current.getBoundingClientRect();
    top = Math.max(top, box.top);
    bottom = Math.min(bottom, box.top + current.clientHeight);
    container ??= current;
  }
  const laidOut =
    container === undefined
      ? (view?.innerHeight ?? 0) > 0
      : container.clientHeight > 0;
  return { top, bottom, container, laidOut };
};

/**
 * The range of lines to draw: those that intersect the part of the window the
 * tree can show (inside every clipping ancestor of `marker`, an element at the
 * tree's top), plus overscan. It follows any ancestor scrolling, resizing and
 * the content moving under it, and draws a new range only when the viewport
 * leaves the drawn one, so scrolling within the overscan renders nothing.
 */
export function useLineRange(
  marker: RefObject<HTMLElement | null>,
  offsets: Float64Array,
): LineRange {
  const count = offsets.length - 1;
  const [range, setRange] = useState<LineRange>({
    first: 0,
    last: initialLines,
  });
  const latest = useRef(offsets);
  latest.current = offsets;
  const measure = useRef<() => void>(() => undefined);

  useLayoutEffect(() => {
    const element = marker.current;
    if (element === null) return;
    const document = element.ownerDocument;
    const view = document.defaultView;
    const remPx = (): number =>
      Number.parseFloat(
        view?.getComputedStyle(document.documentElement).fontSize ?? '',
      ) || 16;
    const Observer = (
      view as (Window & { ResizeObserver?: typeof ResizeObserver }) | null
    )?.ResizeObserver;
    const observer =
      Observer === undefined
        ? undefined
        : new Observer(() => measure.current());
    let observed: HTMLElement | undefined;

    // The viewport resizing, and its content growing or shrinking above or
    // around this tree (another tree in the same container opening).
    const observe = (container: HTMLElement | undefined): void => {
      if (observer === undefined || container === observed) return;
      observer.disconnect();
      observed = container;
      if (container === undefined) return;
      observer.observe(container);
      for (const child of Array.from(container.children)) {
        observer.observe(child);
      }
    };

    measure.current = () => {
      if (!element.isConnected) return;
      const offsets = latest.current;
      const total = offsets.length - 1;
      const viewport = viewportOf(element);
      observe(viewport.container);
      const viewportTop = viewport.top;
      const viewportHeight = Math.max(0, viewport.bottom - viewport.top);

      // A container with no height is not laid out yet (a hidden panel, or a
      // document without layout): draw the initial lines, as before the
      // first measurement, rather than the one line a zero height selects.
      if (!viewport.laidOut) {
        setRange((current) =>
          current.first === 0 && current.last === initialLines
            ? current
            : { first: 0, last: initialLines },
        );

        return;
      }

      const rem = remPx();
      const top = (viewportTop - element.getBoundingClientRect().top) / rem;
      const bottom = top + viewportHeight / rem;
      const visibleFirst = lineAt(offsets, Math.max(0, top));
      const visibleLast =
        bottom <= 0 ? 0 : Math.min(total, lineAt(offsets, bottom) + 1);
      const overscan = overscanFor(viewportHeight / rem / rowHeight);
      // Redraw once the margin left on either side falls below half the
      // overscan, not only once it is gone: a fling is then still inside
      // drawn rows when the new range lands.
      const keep = Math.floor(overscan / 2);
      setRange((current) => {
        const covers =
          current.first <= Math.max(0, visibleFirst - keep) &&
          current.last >= Math.min(total, visibleLast + keep) &&
          current.last <= total + overscan &&
          current.last - current.first <=
            visibleLast - visibleFirst + 4 * overscan;
        if (covers) return current;
        return {
          first: Math.max(0, visibleFirst - overscan),
          last: Math.min(total, visibleLast + overscan),
        };
      });
    };

    // Scroll events do not bubble, but every one passes the document while
    // capturing: whichever ancestor scrolls (or the window) is heard, even
    // one that only started scrolling after this tree mounted.
    const NodeClass = (view as (Window & { Node?: typeof Node }) | null)?.Node;
    const onScroll = (event: Event): void => {
      const target = event.target;
      if (
        target === document ||
        target === view ||
        (NodeClass !== undefined &&
          target instanceof NodeClass &&
          target.contains(element))
      ) {
        // Scroll events run just before the frame paints; an ordinary state
        // update would draw the new rows only after that paint, a frame late.
        flushSync(() => measure.current());
      }
    };
    const onResize = (): void => measure.current();
    document.addEventListener('scroll', onScroll, {
      capture: true,
      passive: true,
    });
    view?.addEventListener('resize', onResize);
    measure.current();
    return () => {
      measure.current = () => undefined;
      document.removeEventListener('scroll', onScroll, { capture: true });
      view?.removeEventListener('resize', onResize);
      observer?.disconnect();
    };
  }, [marker]);

  // New lines (a directory opened or closed, a new tree) may leave the
  // viewport on lines that are not drawn.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the lines change
  useLayoutEffect(() => {
    measure.current();
  }, [offsets]);

  return {
    first: Math.min(range.first, count),
    last: Math.min(range.last, count),
  };
}
