// A real DOM (happy-dom) installed as the window globals a client part and
// the window platform touch: custom elements, the document and history.

import { Window } from 'happy-dom';

const names = [
  'window',
  'document',
  'navigator',
  'location',
  'history',
  'HTMLElement',
  'Node',
  'Element',
  'Event',
  'customElements',
  'MutationObserver',
] as const;

export interface InstalledDom {
  readonly window: Window;
  readonly document: Document;
  readonly registry: CustomElementRegistry;
  close(): Promise<void>;
}

/** Installs a fresh happy-dom window at `url` as the globals. */
export const installDom = (url = 'doric://app/'): InstalledDom => {
  const window = new Window({ url });
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = new Map(
    names.map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );

  for (const name of names) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: (window as unknown as Record<string, unknown>)[name],
    });
  }

  return {
    window,
    document: window.document as unknown as Document,
    registry: window.customElements as unknown as CustomElementRegistry,
    close: async () => {
      for (const [name, descriptor] of previous) {
        if (descriptor === undefined) {
          delete globals[name];
        } else {
          Object.defineProperty(globalThis, name, descriptor);
        }
      }

      await window.happyDOM.close();
    },
  };
};
