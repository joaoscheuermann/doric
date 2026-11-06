// A happy-dom window as this process's globals, installed when this module
// is evaluated: import it before anything that reads `window` at import time
// (react-dom, react-ui, the bundle's client modules).

import { Window } from 'happy-dom';

export const window = new Window({ url: 'http://localhost/' });

const installed = [
  'window',
  'document',
  'location',
  'navigator',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLButtonElement',
  'SVGElement',
  'Element',
  'Node',
  'Text',
  'Event',
  'CustomEvent',
  'KeyboardEvent',
  'MouseEvent',
  'PointerEvent',
  'FocusEvent',
  'InputEvent',
  'customElements',
  'DOMParser',
  'MutationObserver',
  'ResizeObserver',
  'IntersectionObserver',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'matchMedia',
] as const;

for (const name of installed) {
  const value = window[name as keyof Window] as unknown;
  if (value === undefined) continue;
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value:
      typeof value === 'function' && /^[a-z]/.test(name)
        ? (value as (...args: unknown[]) => unknown).bind(window)
        : value,
  });
}

window.document.write('<!DOCTYPE html><html><head></head><body></body></html>');

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** Waits `milliseconds`, then lets pending work run. */
export const settle = (milliseconds = 0): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Closes the window once the file's tests are done. */
export const closeWindow = async (): Promise<void> => {
  await window.happyDOM.abort();
  await window.happyDOM.close();
};
