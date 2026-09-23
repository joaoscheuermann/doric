import type { CommentAnchor } from './editing';

/** Whether a node sits inside a comment island rather than in the answer text. */
export const insideComment = (surface: HTMLElement, node: Node): boolean => {
  let current: HTMLElement | null = node.parentElement;
  while (current !== null && current !== surface) {
    if (current.dataset.commentBlock !== undefined) return true;
    current = current.parentElement;
  }
  return false;
};

/** The rendered character offset of a DOM position inside `element`. */
export const offsetOf = (
  element: HTMLElement,
  node: Node,
  offset: number,
): number => {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let total = 0;
  let current = walker.nextNode();
  while (current !== null) {
    if (current === node) return total + offset;
    if (!insideComment(element, current)) {
      total += current.textContent?.length ?? 0;
    }
    current = walker.nextNode();
  }
  return total;
};

/** The rendered text range a comment marker covers, or `undefined` if it is gone. */
export const domRange = (
  element: HTMLElement,
  start: number,
  end: number,
): Range | undefined => {
  const range = document.createRange();
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let total = 0;
  let opened = false;
  let current = walker.nextNode();
  while (current !== null) {
    const length = insideComment(element, current)
      ? 0
      : (current.textContent?.length ?? 0);
    if (!opened && total + length >= start) {
      range.setStart(current, Math.max(start - total, 0));
      opened = true;
    }
    if (opened && total + length >= end) {
      range.setEnd(current, Math.min(end - total, length));
      return range;
    }
    total += length;
    current = walker.nextNode();
  }
  return undefined;
};

/** The current selection inside `element` as a quotable excerpt, or `undefined`. */
export const selectionAnchor = (
  element: HTMLElement | null,
): CommentAnchor | undefined => {
  if (element === null) return undefined;
  const selection = window.getSelection();
  if (
    selection === null ||
    selection.rangeCount === 0 ||
    selection.isCollapsed
  ) {
    return undefined;
  }
  const range = selection.getRangeAt(0);
  if (!element.contains(range.commonAncestorContainer)) return undefined;
  const start = offsetOf(element, range.startContainer, range.startOffset);
  const end = offsetOf(element, range.endContainer, range.endOffset);
  const quote = selection.toString();
  return quote.trim().length === 0 || end <= start
    ? undefined
    : { quote, start, end };
};

/** Drops the native selection, leaving the caret at its end. */
export const collapseSelection = (): void => {
  const selection = window.getSelection();
  if (selection === null || selection.rangeCount === 0) return;
  selection.collapseToEnd();
};
