import type { RefObject } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { Turn } from '@/domain/projector';
import {
  activeMarkerIndex,
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

/** The attribute the prompt input's block carries — `UserPromptNode.createDOM` writes it. */
const INPUT_BLOCK_SELECTOR = '[data-prompt-input]';

/** What the rail draws: its handles, and the one the scroll speaks for. */
export type ThreadNav = {
  /** The transcript's handles in reading order. */
  readonly markers: readonly ThreadMarker[];
  /** The active handle's index, or `-1` while nothing is highlighted. */
  readonly active: number;
  /** Scrolls the conversation to a marker's own block. */
  readonly jumpTo: (marker: ThreadMarker) => void;
  /** Scrolls the conversation to the prompt input — the rail's last handle. */
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

/**
 * The thread navigation rail's data: destinations become handles, stacked
 * down the rail at fixed spacing, with the marker at or nearest
 * above the viewport's top named active. The measurement follows the transcript
 * as it grows, shifts and streams — blocks arriving, tool blocks opening and
 * closing, the window resizing, the reader scrolling — and it never moves the
 * reader's scroll; only `jumpTo` and `jumpToInput` do that, and only because the
 * reader asked.
 *
 * `scrollRoot` is the conversation's scroll area root; its viewport is found
 * beneath it, so this hook knows nothing of how the surface mounts it.
 */
export function useThreadNav({
  turns,
  scrollRoot,
  navigating,
}: {
  readonly turns: readonly Turn[];
  readonly scrollRoot: RefObject<HTMLElement | null>;
  readonly navigating: RefObject<boolean>;
}): ThreadNav {
  const markers = useMemo(() => threadMarkers(turns), [turns]);
  const [active, setActive] = useState(-1);

  useEffect(() => {
    const viewport = resolveViewport(scrollRoot.current);
    if (viewport === null) return;
    const finishJump = (): void => {
      navigating.current = false;
    };
    viewport.addEventListener('scrollend', finishJump);
    return () => {
      viewport.removeEventListener('scrollend', finishJump);
      navigating.current = false;
    };
  }, [navigating, scrollRoot]);

  const measure = useCallback(() => {
    const viewport = resolveViewport(scrollRoot.current);
    if (viewport === null) return;
    const blocks = blocksByMarker(viewport);
    const tops = markers.map((marker) => {
      const block = blocks.get(markerKey(marker));
      return block === undefined ? null : blockTop(viewport, block);
    });
    const next = activeMarkerIndex(tops, viewport.scrollTop);
    setActive((current) => (current === next ? current : next));
  }, [markers, scrollRoot]);

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
    viewport.addEventListener('scroll', schedule, { passive: true });
    const content = viewport.firstElementChild;
    const resize = new ResizeObserver(schedule);
    resize.observe(viewport);
    if (content !== null) resize.observe(content);
    const mutations = new MutationObserver(schedule);
    if (content !== null)
      mutations.observe(content, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      viewport.removeEventListener('scroll', schedule);
      resize.disconnect();
      mutations.disconnect();
    };
  }, [measure, scrollRoot]);

  const jump = useCallback(
    (viewport: HTMLElement, block: HTMLElement) => {
      const top = Math.max(
        0,
        Math.min(
          blockTop(viewport, block),
          viewport.scrollHeight - viewport.clientHeight,
        ),
      );
      if (Math.abs(viewport.scrollTop - top) <= 1) return;
      navigating.current = true;
      viewport.scrollTo({ top, behavior: 'smooth' });
    },
    [navigating],
  );

  const jumpTo = useCallback(
    (marker: ThreadMarker) => {
      const viewport = resolveViewport(scrollRoot.current);
      const block =
        viewport === null
          ? undefined
          : blocksByMarker(viewport).get(markerKey(marker));
      if (viewport === null || block === undefined) return;
      jump(viewport, block);
    },
    [jump, scrollRoot],
  );

  const jumpToInput = useCallback(() => {
    const viewport = resolveViewport(scrollRoot.current);
    const block =
      viewport?.querySelector<HTMLElement>(INPUT_BLOCK_SELECTOR) ?? null;
    if (viewport === null || block === null) return;
    jump(viewport, block);
  }, [jump, scrollRoot]);

  return {
    markers,
    active,
    jumpTo,
    jumpToInput,
  };
}
