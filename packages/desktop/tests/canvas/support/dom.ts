// A real DOM (happy-dom) installed as the globals React and the canvas hooks
// touch, and a hook renderer over `react-dom/client` with `act`. React is
// imported only once the globals exist, so it sees a DOM.

import { Window } from 'happy-dom';

export const happy = new Window({ url: 'doric://app/' });

const names = [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'HTMLDivElement',
  'HTMLInputElement',
  'HTMLButtonElement',
  'HTMLAnchorElement',
  'HTMLTextAreaElement',
  'HTMLSelectElement',
  'SVGElement',
  'ShadowRoot',
  'DocumentFragment',
  'NodeFilter',
  'ResizeObserver',
  'Element',
  'Node',
  'Event',
  'CustomEvent',
  'MouseEvent',
  'PointerEvent',
  'WheelEvent',
  'KeyboardEvent',
  'FocusEvent',
  'MutationObserver',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
] as const;

for (const name of names) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value: (happy as unknown as Record<string, unknown>)[name],
  });
}
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const react = await import('react');
const { createRoot } = await import('react-dom/client');

export const act = react.act as (
  callback: () => void | Promise<void>,
) => Promise<void>;

export interface RenderedHook<P, R> {
  /** What the hook answered on its latest render. */
  readonly result: () => R;
  readonly rerender: (props: P) => Promise<void>;
  readonly unmount: () => Promise<void>;
}

/** Renders `useHook(props)` in a component of its own. */
export const renderHook = async <P, R>(
  useHook: (props: P) => R,
  props: P,
): Promise<RenderedHook<P, R>> => {
  let latest: { value: R } | undefined;
  const Probe = (probe: { readonly props: P }) => {
    latest = { value: useHook(probe.props) };
    return null;
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);

  await act(() => root.render(react.createElement(Probe, { props })));

  return {
    result: () => {
      if (latest === undefined) throw new Error('the hook never rendered');
      return latest.value;
    },
    rerender: (next) =>
      act(() => root.render(react.createElement(Probe, { props: next }))),
    unmount: async () => {
      await act(() => root.unmount());
      host.remove();
    },
  };
};

/** Closes the DOM once a file's tests are done. */
export const closeDom = async (): Promise<void> => {
  await happy.happyDOM.abort();
  await happy.happyDOM.close();
};

/** Lets pending promises and zero-delay timers settle. */
export const settle = (): Promise<void> =>
  act(() => new Promise((resolve) => setTimeout(resolve, 0)));
