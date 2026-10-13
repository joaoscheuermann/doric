import {
  preserveVisibleBlock,
  type ScrollPlan,
} from '../../../../domain/conversation-scroll.js';

type ScrollReading = {
  readonly element: HTMLElement;
  readonly anchor: HTMLElement | null;
  readonly anchorTop: number;
};

const maxScroll = (element: HTMLElement): number =>
  Math.max(0, element.scrollHeight - element.clientHeight);

/** A block's offset in the scrollable content, independent of the reader's scroll. */
const blockTop = (element: HTMLElement, block: HTMLElement): number =>
  block.getBoundingClientRect().top -
  element.getBoundingClientRect().top +
  element.scrollTop;

/** Find a visible editor block so inserted turns above it cannot move the reader's place. */
const visibleBlock = (
  element: HTMLElement,
  root: HTMLElement,
): HTMLElement | null => {
  const viewport = element.getBoundingClientRect();
  for (const child of Array.from(root.children)) {
    if (!(child instanceof HTMLElement)) continue;
    const bounds = child.getBoundingClientRect();
    if (bounds.bottom > viewport.top && bounds.top < viewport.bottom)
      return child;
  }
  return null;
};

const findScrollElement = (root: HTMLElement | null): HTMLElement | null => {
  const viewport = root?.closest('[data-slot="scroll-area-viewport"]');
  if (viewport instanceof HTMLElement) return viewport;
  let element = root?.parentElement ?? null;
  while (
    element !== null &&
    !/auto|scroll|overlay/.test(getComputedStyle(element).overflowY)
  )
    element = element.parentElement;
  return element;
};

/** Read the viewport before Lexical changes the transcript. */
export const readScroll = (
  root: HTMLElement | null,
  decision: ScrollPlan = 'hold',
): ScrollReading | null => {
  if (decision === 'navigate') return null;
  const element = findScrollElement(root);
  if (element === null) return null;
  if (decision !== 'hold') {
    return { element, anchor: null, anchorTop: 0 };
  }

  const anchor = root === null ? null : visibleBlock(element, root);
  return {
    element,
    anchor,
    anchorTop: anchor === null ? 0 : blockTop(element, anchor),
  };
};

/** Settle the viewport after Lexical has committed its DOM update. */
export const settleScroll = (
  scroll: ScrollReading | null,
  decision: ScrollPlan,
): void => {
  if (scroll === null) return;
  if (decision === 'open' || decision === 'follow') {
    scroll.element.scrollTop = maxScroll(scroll.element);
  } else if (decision === 'hold' && scroll.anchor?.isConnected === true) {
    scroll.element.scrollTop = preserveVisibleBlock(
      scroll.element.scrollTop,
      scroll.anchorTop,
      blockTop(scroll.element, scroll.anchor),
    );
  }
};
