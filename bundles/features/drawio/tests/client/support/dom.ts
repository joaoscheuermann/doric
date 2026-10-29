// The client tests' browser: one happy-dom window, installed on the global
// scope the way Papercraft's client tests install theirs, so the modules
// under test find `document`, `DOMParser` and `XMLSerializer` as they would in
// the app. Import it before the modules under test.

import { Window } from 'happy-dom';

export const window = new Window({
  url: 'https://app.test/',
  settings: { disableIframePageLoading: true, disableCSSFileLoading: true },
});

const installed = [
  'window',
  'document',
  'location',
  'navigator',
  'HTMLElement',
  'HTMLIFrameElement',
  'HTMLImageElement',
  'HTMLTextAreaElement',
  'Element',
  'SVGElement',
  'SVGSVGElement',
  'Node',
  'Event',
  'CustomEvent',
  'MouseEvent',
  'PointerEvent',
  'KeyboardEvent',
  'customElements',
  'DOMParser',
  'XMLSerializer',
  'MutationObserver',
] as const;

for (const name of installed) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: window[name as keyof Window],
    writable: true,
  });
}

/**
 * Readies the window for React and the shared canvas, as Papercraft's element
 * tests do: React's `act` environment; `getComputedStyle` and the animation
 * frames the menus and tooltips schedule; and a layout-free box for every
 * element (happy-dom lays nothing out, so `clientWidth` is 0, the fit stays
 * at identity and a click's client point is its content point).
 */
export const installReactDom = (): void => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;

  for (const name of [
    'getComputedStyle',
    'requestAnimationFrame',
    'cancelAnimationFrame',
  ] as const) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: window[name].bind(window),
      writable: true,
    });
  }

  window.Element.prototype.getBoundingClientRect = function box() {
    return {
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      toJSON: () => ({}),
    } as never;
  };
};

/** Closes the window; call it once a file's tests are done. */
export const closeDom = (): Promise<void> =>
  (
    window as unknown as { happyDOM: { close(): Promise<void> } }
  ).happyDOM.close();

/** Lets pending timers, microtasks and port messages run. */
export const settle = async (rounds = 3): Promise<void> => {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
};

/** The iframes in the document's body. */
export const iframes = (): HTMLIFrameElement[] =>
  [
    ...window.document.body.querySelectorAll('iframe'),
  ] as unknown as HTMLIFrameElement[];
