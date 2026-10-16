// The caret inside a stack note — a plain-text editing host of its own inside
// the conversation: where to put it, and whether it stands on the note's first
// or last visual line, which only the browser can measure.

/** The window an element lives in. */
const viewOf = (element: Element): Window | null =>
  element.ownerDocument.defaultView;

/** Puts the caret in an editable element, at its start or its end. */
export const placeCaret = (element: HTMLElement, atEnd: boolean): void => {
  element.focus({ preventScroll: false });
  const selection = viewOf(element)?.getSelection();
  if (selection === null || selection === undefined) return;
  const range = element.ownerDocument.createRange();
  range.selectNodeContents(element);
  range.collapse(!atEnd);
  selection.removeAllRanges();
  selection.addRange(range);
};

/** The caret's own box, when the browser draws one. */
const caretRect = (element: HTMLElement): DOMRect | undefined => {
  const selection = viewOf(element)?.getSelection();
  if (
    selection === null ||
    selection === undefined ||
    selection.rangeCount === 0
  )
    return undefined;
  const range = selection.getRangeAt(0).cloneRange();
  range.collapse(true);
  const rect = range.getClientRects?.()[0];
  return rect === undefined || (rect.width === 0 && rect.height === 0)
    ? undefined
    : rect;
};

/** The height of one line of the element's text. */
const lineHeight = (element: HTMLElement): number =>
  Number.parseFloat(
    viewOf(element)?.getComputedStyle(element).lineHeight ?? '',
  ) || 20;

/**
 * Whether the caret is on the element's first visual line. A caret the browser
 * draws no box for (an empty note) stands on every line at once.
 */
export const caretOnFirstLine = (element: HTMLElement): boolean => {
  const rect = caretRect(element);
  return (
    rect === undefined ||
    rect.top - element.getBoundingClientRect().top < lineHeight(element) * 0.8
  );
};

/** Whether the caret is on the element's last visual line. */
export const caretOnLastLine = (element: HTMLElement): boolean => {
  const rect = caretRect(element);
  return (
    rect === undefined ||
    element.getBoundingClientRect().bottom - rect.bottom <
      lineHeight(element) * 0.8
  );
};

/** Inserts plain text at the caret, as typing it would. */
export const insertPlainText = (element: HTMLElement, text: string): void => {
  const document = element.ownerDocument;
  // `insertText` keeps the browser's own undo; where it is missing the text
  // goes in through the selection's range.
  if (document.execCommand?.('insertText', false, text) === true) return;
  const selection = viewOf(element)?.getSelection();
  if (
    selection === null ||
    selection === undefined ||
    selection.rangeCount === 0
  )
    return;
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
};
