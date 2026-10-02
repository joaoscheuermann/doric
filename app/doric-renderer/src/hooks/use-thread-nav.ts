import type { Turn } from '@/domain/projector';
import {
  activeMarkerIndex,
  type PromptMarker,
  promptMarkers,
} from '@/domain/thread-nav';
import type { RefObject } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';

/** The scroll area's viewport, the element that actually scrolls. */
const VIEWPORT_SELECTOR = '[data-slot="scroll-area-viewport"]';

/**
 * The attribute a prompt's block carries in the DOM — `UserTurnNode.createDOM`
 * writes it — and the one a marker's `promptId` finds the block by.
 */
const PROMPT_BLOCK_SELECTOR = '[data-prompt-id]';

/** The attribute the prompt input's block carries — `UserPromptNode.createDOM` writes it. */
const INPUT_BLOCK_SELECTOR = '[data-prompt-input]';

/** What the rail draws: its handles, and the one the scroll speaks for. */
export type ThreadNav = {
  /** The handles the transcript's prompts call for, in transcript order. */
  readonly markers: readonly PromptMarker[];
  /** The active handle's index, or `-1` while nothing is highlighted. */
  readonly active: number;
  /** Scrolls the conversation to a prompt — the one way this rail moves it. */
  readonly jumpTo: (promptId: string) => void;
  /** Scrolls the conversation to the prompt input — the rail's last handle. */
  readonly jumpToInput: () => void;
};

const resolveViewport = (root: HTMLElement | null): HTMLElement | null =>
  root?.querySelector<HTMLElement>(VIEWPORT_SELECTOR) ?? null;

/** The prompt blocks the surface draws, keyed by the prompt id each carries. */
const blocksByPrompt = (viewport: HTMLElement): Map<string, HTMLElement> => {
  const blocks = new Map<string, HTMLElement>();
  for (const block of Array.from(
    viewport.querySelectorAll<HTMLElement>(PROMPT_BLOCK_SELECTOR),
  )) {
    const promptId = block.dataset.promptId;
    if (promptId !== undefined && promptId !== '' && !blocks.has(promptId))
      blocks.set(promptId, block);
  }
  return blocks;
};

/** A block's offset in the scroll content, measured from the viewport's top. */
const blockTop = (viewport: HTMLElement, block: HTMLElement): number =>
  block.getBoundingClientRect().top -
  viewport.getBoundingClientRect().top +
  viewport.scrollTop;

/**
 * The thread navigation rail's data: the prompts the reader wrote become
 * handles, stacked down the rail at fixed spacing, with the prompt at or nearest
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
}: {
  readonly turns: readonly Turn[];
  readonly scrollRoot: RefObject<HTMLElement | null>;
}): ThreadNav {
  const markers = useMemo(() => promptMarkers(turns), [turns]);
  const [active, setActive] = useState(-1);

  const measure = useCallback(() => {
    const viewport = resolveViewport(scrollRoot.current);
    if (viewport === null) return;
    const blocks = blocksByPrompt(viewport);
    const tops = markers.map((marker) => {
      const block = blocks.get(marker.promptId);
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

  const jumpTo = useCallback(
    (promptId: string) => {
      const viewport = resolveViewport(scrollRoot.current);
      const block =
        viewport === null ? undefined : blocksByPrompt(viewport).get(promptId);
      if (viewport === null || block === undefined) return;
      viewport.scrollTo({ top: blockTop(viewport, block), behavior: 'smooth' });
    },
    [scrollRoot],
  );

  const jumpToInput = useCallback(() => {
    const viewport = resolveViewport(scrollRoot.current);
    const block =
      viewport?.querySelector<HTMLElement>(INPUT_BLOCK_SELECTOR) ?? null;
    if (viewport === null || block === null) return;
    viewport.scrollTo({ top: blockTop(viewport, block), behavior: 'smooth' });
  }, [scrollRoot]);

  return {
    markers,
    active,
    jumpTo,
    jumpToInput,
  };
}
