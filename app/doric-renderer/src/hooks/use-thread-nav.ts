import type { RefObject } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { PROMPT_INPUT_ATTRIBUTE } from '@/domain/conversation-nodes';
import { atEnd } from '@/domain/conversation-scroll';
import type { Turn } from '@/domain/projector';
import {
  activeMarkerIndex,
  markerScrollTop,
  type ThreadMarker,
  threadMarkers,
} from '@/domain/thread-nav';

/** The scroll area's viewport, the element that actually scrolls. */
const VIEWPORT_SELECTOR = '[data-slot="scroll-area-viewport"]';

/**
 * The attributes the three transcript blocks carry in the DOM.
 */
const PROMPT_BLOCK_SELECTOR = '[data-prompt-id]';
const QUEUED_BLOCK_SELECTOR = '[data-queued-prompt-id]';
const INPUT_MARKER_KEY = 'prompt-input';
const INPUT_BLOCK_SELECTOR = `[${PROMPT_INPUT_ATTRIBUTE}]`;
const HIGHLIGHT_DELAY = 80;

/** What the rail draws: its handles, and the one the scroll speaks for. */
export type ThreadNav = {
  /** The transcript's handles in reading order. */
  readonly markers: readonly ThreadMarker[];
  /** The active handle's index, or `-1` while nothing is highlighted. */
  readonly active: number;
  /** Scrolls the conversation to a marker's own block. */
  readonly jumpTo: (marker: ThreadMarker) => void;
  /** Scrolls to the end and follows it — the rail's last handle. */
  readonly jumpToInput: () => void;
};

const resolveViewport = (root: HTMLElement | null): HTMLElement | null =>
  root?.querySelector<HTMLElement>(VIEWPORT_SELECTOR) ?? null;

const markerKey = (marker: Pick<ThreadMarker, 'kind' | 'promptId'>): string =>
  `${marker.kind}:${marker.promptId}`;

/** The blocks the surface draws, keyed by marker kind and prompt id. */
const blocksByMarker = (viewport: HTMLElement): Map<string, HTMLElement> => {
  const blocks = new Map<string, HTMLElement>();
  for (const block of Array.from(
    viewport.querySelectorAll<HTMLElement>(PROMPT_BLOCK_SELECTOR),
  )) {
    const promptId = block.dataset.promptId;
    if (promptId === undefined || promptId === '') continue;
    const kind =
      block.dataset.resultPromptId === undefined ? 'prompt' : 'result';
    const key = markerKey({ kind, promptId });
    if (!blocks.has(key)) blocks.set(key, block);
  }
  for (const block of Array.from(
    viewport.querySelectorAll<HTMLElement>(QUEUED_BLOCK_SELECTOR),
  )) {
    const promptId = block.dataset.queuedPromptId;
    if (promptId === undefined || promptId === '') continue;
    const key = markerKey({ kind: 'queued', promptId });
    if (!blocks.has(key)) blocks.set(key, block);
  }
  return blocks;
};

/** A block's offset in the scroll content, measured from the viewport's top. */
const blockTop = (viewport: HTMLElement, block: HTMLElement): number =>
  block.getBoundingClientRect().top -
  viewport.getBoundingClientRect().top +
  viewport.scrollTop;

/** How far the viewport scrolls, whatever its content is at the moment. */
const maxScroll = (viewport: HTMLElement): number =>
  Math.max(0, viewport.scrollHeight - viewport.clientHeight);

/**
 * The thread navigation rail's data: destinations become handles, stacked
 * down the rail at fixed spacing, with a visible result or the marker at or
 * nearest above the viewport's reading line named active. The measurement follows the transcript
 * as it grows, shifts and streams — blocks arriving, tool blocks opening and
 * closing, the window resizing, the reader scrolling. Opening a thread or
 * choosing the last handle follows the end until the reader scrolls.
 *
 * `scrollRoot` is the conversation's scroll area root; its viewport is found
 * beneath it, so this hook knows nothing of how the surface mounts it.
 */
export function useThreadNav({
  turns,
  scrollRoot,
  navigating,
  following,
}: {
  readonly turns: readonly Turn[];
  readonly scrollRoot: RefObject<HTMLElement | null>;
  readonly navigating: RefObject<boolean>;
  readonly following: RefObject<boolean>;
}): ThreadNav {
  const markers = useMemo(() => threadMarkers(turns), [turns]);
  const [active, setActive] = useState(-1);
  const suppressResume = useRef(false);
  const jumpFrame = useRef<number | null>(null);
  const selectedMarker = useRef<string | null>(null);
  const highlightedBlock = useRef<HTMLElement | null>(null);
  const highlightTimer = useRef<number | null>(null);
  const highlightDismissed = useRef(false);

  const clearHighlight = useCallback((): void => {
    if (highlightTimer.current !== null)
      window.clearTimeout(highlightTimer.current);
    highlightTimer.current = null;
    highlightedBlock.current?.removeAttribute('data-trail-highlight');
    highlightedBlock.current = null;
  }, []);

  const showHighlight = useCallback(
    (block: HTMLElement, strong: boolean): void => {
      if (strong) highlightDismissed.current = false;
      clearHighlight();
      highlightedBlock.current = block;
      block.dataset.trailHighlight = strong ? 'strong' : 'subtle';
      if (strong)
        highlightTimer.current = window.setTimeout(() => {
          highlightTimer.current = null;
          if (highlightedBlock.current === block)
            block.dataset.trailHighlight = 'subtle';
        }, HIGHLIGHT_DELAY);
    },
    [clearHighlight],
  );

  useEffect(
    () => () => {
      if (jumpFrame.current !== null) cancelAnimationFrame(jumpFrame.current);
      navigating.current = false;
      clearHighlight();
    },
    [clearHighlight, navigating],
  );

  const measure = useCallback(() => {
    const viewport = resolveViewport(scrollRoot.current);
    if (viewport === null) return;
    const blocks = blocksByMarker(viewport);
    const positions = markers.map((marker) => {
      const block = blocks.get(markerKey(marker));
      return {
        kind: marker.kind,
        top: block === undefined ? null : blockTop(viewport, block),
      };
    });
    const selectedIndex =
      selectedMarker.current === null ||
      selectedMarker.current === INPUT_MARKER_KEY
        ? -1
        : markers.findIndex(
            (marker) => markerKey(marker) === selectedMarker.current,
          );
    if (
      selectedMarker.current !== null &&
      selectedMarker.current !== INPUT_MARKER_KEY &&
      selectedIndex < 0
    ) {
      selectedMarker.current = null;
      clearHighlight();
    } else if (selectedMarker.current !== null && !highlightDismissed.current) {
      const block =
        selectedMarker.current === INPUT_MARKER_KEY
          ? viewport.querySelector<HTMLElement>(INPUT_BLOCK_SELECTOR)
          : blocks.get(selectedMarker.current);
      if (block !== highlightedBlock.current) {
        if (block === null || block === undefined) clearHighlight();
        else showHighlight(block, false);
      }
    }
    const next =
      selectedIndex >= 0
        ? selectedIndex
        : activeMarkerIndex(
            positions,
            viewport.scrollTop,
            viewport.clientHeight,
          );
    setActive((current) => (current === next ? current : next));
  }, [clearHighlight, markers, scrollRoot, showHighlight]);

  useEffect(() => {
    const viewport = resolveViewport(scrollRoot.current);
    if (viewport === null) return;
    // One measurement per frame however many scrolls and mutations arrive.
    let frame: number | null = null;
    const schedule = (): void => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        measure();
      });
    };
    schedule();
    const resumeAtEnd = (): void => {
      if (
        suppressResume.current ||
        navigating.current ||
        !atEnd(viewport.scrollTop, viewport.scrollHeight, viewport.clientHeight)
      )
        return;
      following.current = true;
      viewport.scrollTop = maxScroll(viewport);
    };
    const onScroll = (): void => {
      resumeAtEnd();
      schedule();
    };
    viewport.addEventListener('scroll', onScroll, { passive: true });
    const content = viewport.firstElementChild;
    const followGrowth = (): void => {
      if (following.current && !navigating.current)
        viewport.scrollTop = maxScroll(viewport);
      schedule();
    };
    const resize = new ResizeObserver(followGrowth);
    resize.observe(viewport);
    if (content !== null) resize.observe(content);
    const mutations = new MutationObserver(followGrowth);
    if (content !== null)
      mutations.observe(content, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    const root = scrollRoot.current;
    const dismissOnHover = (event: PointerEvent): void => {
      if (
        (event.pointerType !== 'mouse' && event.pointerType !== 'pen') ||
        !(event.target instanceof Node) ||
        !highlightedBlock.current?.contains(event.target)
      )
        return;
      highlightDismissed.current = true;
      clearHighlight();
    };
    const releaseSelection = (): void => {
      selectedMarker.current = null;
      clearHighlight();
      schedule();
    };
    const leaveEnd = (): void => {
      following.current = false;
    };
    const onWheel = (event: WheelEvent): void => {
      if (event.deltaY !== 0) releaseSelection();
      if (event.deltaY < 0) {
        suppressResume.current = true;
        leaveEnd();
      } else if (event.deltaY > 0) {
        suppressResume.current = false;
        resumeAtEnd();
      }
    };
    let draggingScrollbar = false;
    const leaveOnScrollbar = (event: PointerEvent): void => {
      const scrollbar = root?.querySelector(
        '[data-slot="scroll-area-scrollbar"]',
      );
      if (event.target instanceof Node && scrollbar?.contains(event.target)) {
        draggingScrollbar = true;
        releaseSelection();
        suppressResume.current = true;
        leaveEnd();
      }
    };
    const finishScrollbarDrag = (): void => {
      if (!draggingScrollbar) return;
      draggingScrollbar = false;
      suppressResume.current = false;
      resumeAtEnd();
    };
    const onTouchMove = (): void => {
      releaseSelection();
      suppressResume.current = true;
      leaveEnd();
    };
    const onTouchEnd = (): void => {
      suppressResume.current = false;
      resumeAtEnd();
    };
    const leaveOnKey = (event: KeyboardEvent): void => {
      if (
        ['PageUp', 'Home'].includes(event.key) ||
        (event.target === viewport && event.key === 'ArrowUp')
      ) {
        releaseSelection();
        suppressResume.current = true;
        leaveEnd();
      } else if (
        ['PageDown', 'End'].includes(event.key) ||
        (event.target === viewport && ['ArrowDown', ' '].includes(event.key))
      ) {
        releaseSelection();
        suppressResume.current = false;
        resumeAtEnd();
      }
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      if (
        ['PageUp', 'Home'].includes(event.key) ||
        (event.target === viewport && event.key === 'ArrowUp')
      ) {
        suppressResume.current = false;
        resumeAtEnd();
      }
    };
    root?.addEventListener('wheel', onWheel, { capture: true, passive: true });
    root?.addEventListener('touchmove', onTouchMove, {
      capture: true,
      passive: true,
    });
    root?.addEventListener('touchend', onTouchEnd);
    root?.addEventListener('pointerdown', leaveOnScrollbar, true);
    viewport.addEventListener('pointerover', dismissOnHover);
    root?.addEventListener('keydown', leaveOnKey, true);
    root?.addEventListener('keyup', onKeyUp);
    window.addEventListener('pointerup', finishScrollbarDrag);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      viewport.removeEventListener('scroll', onScroll);
      resize.disconnect();
      mutations.disconnect();
      root?.removeEventListener('wheel', onWheel, true);
      root?.removeEventListener('touchmove', onTouchMove, true);
      root?.removeEventListener('touchend', onTouchEnd);
      root?.removeEventListener('pointerdown', leaveOnScrollbar, true);
      viewport.removeEventListener('pointerover', dismissOnHover);
      root?.removeEventListener('keydown', leaveOnKey, true);
      root?.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('pointerup', finishScrollbarDrag);
    };
  }, [clearHighlight, following, measure, navigating, scrollRoot]);

  const jump = useCallback(
    (viewport: HTMLElement, block: HTMLElement) => {
      following.current = false;
      suppressResume.current = true;
      const top = markerScrollTop(
        blockTop(viewport, block),
        viewport.clientHeight,
        maxScroll(viewport),
      );
      if (Math.abs(viewport.scrollTop - top) <= 1) return;
      navigating.current = true;
      viewport.scrollTo({ top, behavior: 'instant' });
      if (jumpFrame.current !== null) cancelAnimationFrame(jumpFrame.current);
      jumpFrame.current = requestAnimationFrame(() => {
        navigating.current = false;
        jumpFrame.current = null;
      });
    },
    [following, navigating],
  );

  const jumpTo = useCallback(
    (marker: ThreadMarker) => {
      const key = markerKey(marker);
      const viewport = resolveViewport(scrollRoot.current);
      const block =
        viewport === null ? undefined : blocksByMarker(viewport).get(key);
      if (viewport === null || block === undefined) return;
      selectedMarker.current = key;
      setActive(markers.findIndex((item) => markerKey(item) === key));
      showHighlight(block, true);
      jump(viewport, block);
    },
    [jump, markers, scrollRoot, showHighlight],
  );

  /** The last handle goes to the end and keeps following new content. */
  const jumpToInput = useCallback(() => {
    const viewport = resolveViewport(scrollRoot.current);
    if (viewport === null) return;
    if (jumpFrame.current !== null) cancelAnimationFrame(jumpFrame.current);
    jumpFrame.current = null;
    navigating.current = false;
    suppressResume.current = false;
    selectedMarker.current = INPUT_MARKER_KEY;
    following.current = true;
    viewport.scrollTo({ top: maxScroll(viewport), behavior: 'instant' });
    const input = viewport.querySelector<HTMLElement>(INPUT_BLOCK_SELECTOR);
    if (input === null) clearHighlight();
    else showHighlight(input, true);
    measure();
  }, [
    clearHighlight,
    following,
    measure,
    navigating,
    scrollRoot,
    showHighlight,
  ]);

  return {
    markers,
    active,
    jumpTo,
    jumpToInput,
  };
}
