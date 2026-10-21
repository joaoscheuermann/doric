// Keeps the conversation's editor off a surface of its own inside the
// transcript (the comment groups, an inline comment): every event that starts
// there is marked handled for the editor (`stopLexicalPropagation`), so its key
// commands — Enter's paragraph, a typed character — its clipboard and its click
// handling never act on the surface, while the surface's own handlers and the
// browser's defaults (a button's activation) still run.

import { stopLexicalPropagation } from 'lexical';

/**
 * The events such a surface answers itself. The editor listens for each of
 * them on its root; marking them handled keeps it from acting on them.
 */
const OWN_EVENTS = [
  'keydown',
  'beforeinput',
  'input',
  'compositionstart',
  'compositionend',
  'paste',
  'cut',
  'copy',
  'drop',
  'dragstart',
  'dragover',
  'dragend',
  'pointerdown',
  'click',
] as const;

/**
 * Makes every event that starts in `element` its own, never the editor's, for
 * as long as it stands: a ref callback, whose cleanup lets go.
 */
export const isolate = (
  element: HTMLElement | null,
): (() => void) | undefined => {
  if (element === null) return undefined;
  for (const name of OWN_EVENTS)
    element.addEventListener(name, stopLexicalPropagation);
  return () => {
    for (const name of OWN_EVENTS)
      element.removeEventListener(name, stopLexicalPropagation);
  };
};
