/** The part of a rendered box that line-edge detection reads. */
export type RenderedBox = {
  readonly top: number;
  readonly bottom: number;
  readonly height: number;
  readonly width: number;
};

/**
 * Whether a box carries no area at all. A collapsed range in an empty block —
 * the `<p><br></p>` an empty Lexical document holds — reports a 0x0 rect, so
 * its position says nothing about the line it is on.
 */
const emptyBox = (box: RenderedBox): boolean =>
  box.height === 0 && box.width === 0;

/**
 * Half a line of slack: an editor's min-height or padding can separate the
 * measured box from the container's edge without leaving the first/last line.
 */
const slackOf = (box: RenderedBox): number => Math.max(1, box.height / 2);

/**
 * Whether the caret sits on the container's first or last line, judged from
 * boxes alone. `block` is the caret's block box, used when the caret rect is
 * empty: the empty caret shares the only line that box has.
 */
export const caretAtLineEdgeOfBoxes = (
  key: 'ArrowUp' | 'ArrowDown',
  caret: RenderedBox,
  block: RenderedBox | undefined,
  container: RenderedBox,
): boolean => {
  const measured = emptyBox(caret) ? block : caret;
  if (measured === undefined) return false;
  const slack = slackOf(measured);
  return key === 'ArrowUp'
    ? measured.top - container.top <= slack
    : container.bottom - measured.bottom <= slack;
};

/** The collapsed range of the selection inside `element`, when there is one. */
const collapsedRangeIn = (element: HTMLElement): Range | undefined => {
  const selection = window.getSelection();
  if (
    selection === null ||
    selection.rangeCount === 0 ||
    !selection.isCollapsed ||
    !element.contains(selection.getRangeAt(0).startContainer)
  ) {
    return undefined;
  }
  return selection.getRangeAt(0);
};

/**
 * The nearest block-level ancestor of `node` inside `root`: the box whose lines
 * the caret shares. It is the innermost block, so a caret in a list item
 * measures that item rather than the whole list. Only an empty caret rect reads
 * this box, and an empty line has to answer the edge question about its own
 * block.
 */
const blockOf = (root: HTMLElement, node: Node): HTMLElement | undefined => {
  const view = root.ownerDocument.defaultView;
  let current: HTMLElement | null =
    node instanceof HTMLElement ? node : node.parentElement;
  while (current !== null && current !== root) {
    if (laysOutItsOwnLines(current, view)) return current;
    current = current.parentElement;
  }
  return undefined;
};

/** Whether an element lays lines out itself instead of joining a neighbour's. */
const laysOutItsOwnLines = (
  element: HTMLElement,
  view: Window | null,
): boolean => {
  const display = view?.getComputedStyle(element).display ?? 'block';
  return (
    !display.startsWith('inline') &&
    display !== 'contents' &&
    display !== 'none'
  );
};

/** The caret's rendered line inside an element, for vertical edge detection. */
export const caretAtLineEdge = (
  element: HTMLElement | null,
  key: 'ArrowUp' | 'ArrowDown',
  range?: Range,
): boolean => {
  if (element === null) return false;
  const active = range ?? collapsedRangeIn(element);
  if (active === undefined) return false;
  const block = blockOf(element, active.startContainer);
  return caretAtLineEdgeOfBoxes(
    key,
    active.getBoundingClientRect(),
    block?.getBoundingClientRect(),
    element.getBoundingClientRect(),
  );
};

/** Whether a collapsed caret sits at the element's first or last character. */
export const caretAtOffsetEdge = (
  element: HTMLElement | null,
  key: 'ArrowLeft' | 'ArrowRight',
): boolean => {
  if (element === null) return false;
  const range = collapsedRangeIn(element);
  if (range === undefined) return false;
  let offset = 0;
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();
  while (current !== null) {
    if (current === range.startContainer) {
      offset += range.startOffset;
      break;
    }
    offset += current.textContent?.length ?? 0;
    current = walker.nextNode();
  }
  const length = element.textContent?.length ?? 0;
  return key === 'ArrowLeft' ? offset === 0 : offset >= length;
};
