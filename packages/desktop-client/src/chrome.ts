// The window chrome as CSS variables on the root element (section 8.3).

import type { WindowChrome } from './protocol.js';

export const applyChrome = (
  chrome: WindowChrome,
  root: HTMLElement = globalThis.document.documentElement,
): void => {
  const { style } = root;

  style.setProperty('--doric-titlebar-height', `${chrome.height}px`);
  style.setProperty('--doric-safe-top', `${chrome.safeArea.top}px`);
  style.setProperty('--doric-safe-left', `${chrome.safeArea.left}px`);
  style.setProperty('--doric-safe-right', `${chrome.safeArea.right}px`);
};
