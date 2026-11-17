import type { RefObject } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { PROMPT_INPUT_ATTRIBUTE } from '../domain/conversation-nodes.js';
import { atEnd } from '../domain/conversation-scroll.js';
import type { Turn } from '../domain/projector.js';
import {
  activeMarkerIndex,
  markerScrollTop,
  sameMarkers,
  type ThreadMarker,
  threadMarkers,
} from '../domain/thread-nav.js';

/** The scroll area's viewport, the element that actually scrolls. */
const VIEWPORT_SELECTOR = '[data-slot="scroll-area-viewport"]';

/** The conversation's scroll area; anything outside it under `root` is the rail. */
const SCROLL_AREA_SELECTOR = '[data-slot="scroll-area"]';

/** Pixels per wheel line, for wheels that report their delta in lines. */
const WHEEL_LINE_HEIGHT = 16;

/** `WheelEvent.deltaMode` values: deltas counted in lines, or in pages. */
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

/** The attribute a transcript prompt block carries in the DOM. */
const PROMPT_BLOCK_SELECTOR = '[data-prompt-id]:not([data-result-prompt-id])';
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

/**
 * The prompt blocks the surface draws, keyed by `promptId`.
 *
 * Accepts the scroll viewport and returns a fresh map. When two blocks carry
 * the same id, the first in document order wins. Blocks that carry
 * `data-result-prompt-id` (a delegated result) and queued receipts are left
 * out. Prompts with no block are simply absent, never an error. The scan reads
 * the direct children of `[data-lexical-editor]` when it holds any prompt
 * block, and otherwise every `[data-prompt-id]` under the viewport.
 */
const promptBlocks = (viewport: HTMLElement): Map<string, HTMLElement> => {
  const blocks = new Map<string, HTMLElement>();
  const editorRoot = viewport.querySelector<HTMLElement>(
    '[data-lexical-editor]',
  );
  if (editorRoot !== null) {
    for (const child of Array.from(editorRoot.children)) {
      if (!(child instanceof HTMLElement)) continue;
      if (child.dataset.resultPromptId !== undefined) continue;
      const promptId = child.dataset.promptId;
      if (promptId !== undefined && promptId !== '' && !blocks.has(promptId))
        blocks.set(promptId, child);
    }
    if (blocks.size > 0) return blocks;
  }

  for (const block of Array.from(
    viewport.querySelectorAll<HTMLElement>(PROMPT_BLOCK_SELECTOR),
  )) {
    const promptId = block.dataset.promptId;
    if (promptId === undefined || promptId === '' || blocks.has(promptId))
      continue;
    blocks.set(promptId, block);
  }
  return blocks;
};

/** A block's offset in the scroll content, measured from a precomputed viewport top. */
const blockTopFrom = (
  viewportTop: number,
  viewportScrollTop: number,
  block: HTMLElement,
): number =>
  block.getBoundingClientRect().top - viewportTop + viewportScrollTop;

/** A block's offset in the scroll content, measured from the viewport's top. */
const blockTop = (viewport: HTMLElement, block: HTMLElement): number =>
  blockTopFrom(viewport.getBoundingClientRect().top, viewport.scrollTop, block);

/** How far the viewport scrolls, whatever its content is at the moment. */
const maxScroll = (viewport: HTMLElement): number =>
  Math.max(0, viewport.scrollHeight - viewport.clientHeight);

/**
 * The thread navigation rail's data: the reader's prompts become handles, with
 * the prompt at or nearest above the viewport's reading line named active. The
 * measurement follows the transcript as it grows, shifts and streams: blocks
 * arriving, tool blocks opening and closing, the window resizing, the reader
 * scrolling. Opening a thread or choosing the last handle follows the end until
 * the reader scrolls.
 *
 * `root` is the element that holds both the conversation's scroll area and
 * the rail's column. The hook finds the scroll viewport beneath it, so it knows
 * nothing of how the surface mounts either. While `root` or its viewport is
 * missing, `markers` still reflects `turns`, `active` is `-1`, and the jumps do
 * nothing. `markers` keeps its identity while `sameMarkers` holds.
 */
export function useThreadNav({
  turns,
  root,
  navigating,
  following,
}: {
  readonly turns: readonly Turn[];
  readonly root: RefObject<HTMLElement | null>;
  readonly navigating: RefObject<boolean>;
  readonly following: RefObject<boolean>;
}): ThreadNav {
  // The handles keep their identity while they read the same: a flush of
  // deltas changes the turns, not the handles, and a rail handed the same
  // handles measures nothing twice and re-renders no handle for it.
  const fresh = useMemo(() => threadMarkers(turns), [turns]);
  const held = useRef(fresh);
  if (!sameMarkers(held.current, fresh)) held.current = fresh;
  const markers = held.current;
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
    const viewport = resolveViewport(root.current);
    if (viewport === null) return;
    const blocks = promptBlocks(viewport);
    const viewportTop = viewport.getBoundingClientRect().top;
    const viewportScrollTop = viewport.scrollTop;
    const viewportClientHeight = viewport.clientHeight;
    const positions = markers.map((marker) => {
      const block = blocks.get(marker.promptId);
      return {
        top:
          block === undefined
            ? null
            : blockTopFrom(viewportTop, viewportScrollTop, block),
      };
    });
    const selectedIndex =
      selectedMarker.current === null ||
      selectedMarker.current === INPUT_MARKER_KEY
        ? -1
        : markers.findIndex(
            (marker) => marker.promptId === selectedMarker.current,
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
        : activeMarkerIndex(positions, viewportScrollTop, viewportClientHeight);
    setActive((current) => (current === next ? current : next));
  }, [clearHighlight, markers, root, showHighlight]);

  const measureRef = useRef(measure);
  measureRef.current = measure;

  useEffect(() => {
    measure();
  }, [measure]);

  useEffect(() => {
    const viewport = resolveViewport(root.current);
    if (viewport === null) return;
    // One measurement per frame however many scrolls and mutations arrive.
    let frame: number | null = null;
    const schedule = (): void => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        measureRef.current();
      });
    };
    let scrollSettleFrame: number | null = null;
    const scheduleFollowGrowth = (): void => {
      if (
        following.current &&
        !navigating.current &&
        scrollSettleFrame === null
      ) {
        scrollSettleFrame = requestAnimationFrame(() => {
          scrollSettleFrame = null;
          if (following.current && !navigating.current) {
            viewport.scrollTop = maxScroll(viewport);
          }
        });
      }
      schedule();
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
    const resize = new ResizeObserver(scheduleFollowGrowth);
    resize.observe(viewport);
    if (content !== null) resize.observe(content);
    const mutations = new MutationObserver(scheduleFollowGrowth);
    if (content !== null)
      mutations.observe(content, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    const rootElement = root.current;
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
    // The rail stands beside the scroll area, so a wheel or a swipe over it
    // reaches no scroller; the conversation scrolls for it.
    const outsideScrollArea = (target: EventTarget | null): boolean =>
      target instanceof Element &&
      target.closest(SCROLL_AREA_SELECTOR) === null;
    const onWheel = (event: WheelEvent): void => {
      if (event.deltaY !== 0) releaseSelection();
      if (event.deltaY < 0) {
        suppressResume.current = true;
        leaveEnd();
      } else if (event.deltaY > 0) {
        suppressResume.current = false;
        resumeAtEnd();
      }
      if (event.deltaY === 0 || !outsideScrollArea(event.target)) return;
      const unit =
        event.deltaMode === DOM_DELTA_PAGE
          ? viewport.clientHeight
          : event.deltaMode === DOM_DELTA_LINE
            ? WHEEL_LINE_HEIGHT
            : 1;
      viewport.scrollTop += event.deltaY * unit;
    };
    let draggingScrollbar = false;
    const leaveOnScrollbar = (event: PointerEvent): void => {
      const scrollbar = rootElement?.querySelector(
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
    let touchY: number | null = null;
    const onTouchStart = (event: TouchEvent): void => {
      touchY = event.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (event: TouchEvent): void => {
      releaseSelection();
      suppressResume.current = true;
      leaveEnd();
      const y = event.touches[0]?.clientY;
      if (y === undefined) return;
      if (touchY !== null && outsideScrollArea(event.target))
        viewport.scrollTop += touchY - y;
      touchY = y;
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
    rootElement?.addEventListener('wheel', onWheel, {
      capture: true,
      passive: true,
    });
    rootElement?.addEventListener('touchstart', onTouchStart, {
      capture: true,
      passive: true,
    });
    rootElement?.addEventListener('touchmove', onTouchMove, {
      capture: true,
      passive: true,
    });
    rootElement?.addEventListener('touchend', onTouchEnd);
    rootElement?.addEventListener('pointerdown', leaveOnScrollbar, true);
    viewport.addEventListener('pointerover', dismissOnHover);
    rootElement?.addEventListener('keydown', leaveOnKey, true);
    rootElement?.addEventListener('keyup', onKeyUp);
    window.addEventListener('pointerup', finishScrollbarDrag);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      if (scrollSettleFrame !== null) cancelAnimationFrame(scrollSettleFrame);
      viewport.removeEventListener('scroll', onScroll);
      resize.disconnect();
      mutations.disconnect();
      rootElement?.removeEventListener('wheel', onWheel, true);
      rootElement?.removeEventListener('touchstart', onTouchStart, true);
      rootElement?.removeEventListener('touchmove', onTouchMove, true);
      rootElement?.removeEventListener('touchend', onTouchEnd);
      rootElement?.removeEventListener('pointerdown', leaveOnScrollbar, true);
      viewport.removeEventListener('pointerover', dismissOnHover);
      rootElement?.removeEventListener('keydown', leaveOnKey, true);
      rootElement?.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('pointerup', finishScrollbarDrag);
    };
  }, [clearHighlight, following, navigating, root]);

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
      const key = marker.promptId;
      const viewport = resolveViewport(root.current);
      const block =
        viewport === null ? undefined : promptBlocks(viewport).get(key);
      if (viewport === null || block === undefined) return;
      selectedMarker.current = key;
      setActive(markers.findIndex((item) => item.promptId === key));
      showHighlight(block, true);
      jump(viewport, block);
    },
    [jump, markers, root, showHighlight],
  );

  /** The last handle goes to the end and keeps following new content. */
  const jumpToInput = useCallback(() => {
    const viewport = resolveViewport(root.current);
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
  }, [clearHighlight, following, measure, navigating, root, showHighlight]);

  return {
    markers,
    active,
    jumpTo,
    jumpToInput,
  };
}
