// The Screens pane's stories as a preview window shows them: every preview of
// the stories loads a copy of their modules of its own, and every copy shares
// the window's one custom element registry. A story renders its pane without a
// render error however many copies came before it — React reports a render
// that threw once and then recovered as error #520 (`onRecoverableError`),
// which is what a story defining its elements while it renders produced.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { Window } from 'happy-dom';

import type { ScreensPane as ScreensPaneType } from '../../stories/support/screens.js';

const window = new Window({ url: 'http://localhost/' });
const installed = [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'HTMLIFrameElement',
  'SVGElement',
  'Node',
  'Element',
  'Event',
  'customElements',
  'MutationObserver',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'matchMedia',
] as const;

let act: (callback: () => void | Promise<void>) => Promise<void>;
let createRoot: typeof import('react-dom/client')['createRoot'];
let createElement: typeof import('react')['createElement'];
let fixtures: typeof import('../../stories/support/fixtures.js');

/** One copy of the stories' pane module, as one preview loads it. */
const loadCopy = async (copy: number): Promise<typeof ScreensPaneType> => {
  if (copy === 1)
    return (await import('../../stories/support/screens.js')).ScreensPane;
  const url = new URL('../../stories/support/screens.js', import.meta.url);
  url.searchParams.set('copy', String(copy));
  return ((await import(url.href)) as { ScreensPane: typeof ScreensPaneType })
    .ScreensPane;
};

before(async () => {
  for (const name of installed) {
    const value = window[name as keyof Window] as unknown;
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value:
        typeof value === 'function' && /^[a-z]/.test(name)
          ? (value as (...args: unknown[]) => unknown).bind(window)
          : value,
      writable: true,
    });
  }
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act, createElement } = await import('react'));
  ({ createRoot } = await import('react-dom/client'));
  fixtures = await import('../../stories/support/fixtures.js');
});

after(async () => {
  await window.happyDOM.abort();
  await window.happyDOM.close();
});

const settle = async (): Promise<void> => {
  for (let round = 0; round < 5; round += 1) {
    await act(() => new Promise<void>((done) => setTimeout(done, 0)));
  }
};

/** Every error React reported while rendering, recovered from or not. */
const describe = (error: unknown): string => {
  const chain: string[] = [];
  for (let at = error; at !== undefined && chain.length < 3; ) {
    chain.push(at instanceof Error ? at.message : String(at));
    at = at instanceof Error ? at.cause : undefined;
  }
  return chain.join(' <- ');
};

test('every copy of the stories renders its pane without a render error', async () => {
  const errors: string[] = [];
  const body = window.document.body as unknown as HTMLElement;
  const roots: ReturnType<typeof createRoot>[] = [];

  try {
    for (const copy of [1, 2, 3]) {
      const ScreensPane = await loadCopy(copy);
      const container = window.document.createElement(
        'div',
      ) as unknown as HTMLElement;
      body.append(container);
      const root = createRoot(container, {
        onRecoverableError: (error) => errors.push(describe(error)),
        onUncaughtError: (error) => errors.push(describe(error)),
        onCaughtError: (error) => errors.push(describe(error)),
      });
      roots.push(root);
      await act(() =>
        root.render(
          createElement(ScreensPane, {
            setup: {
              views: [fixtures.readyView],
              selection: fixtures.checkoutSelection,
            },
          }),
        ),
      );
      await settle();

      assert.match(
        (container.textContent ?? '').replace(/\s+/g, ' '),
        /Checkout web/,
        `Copy ${copy} drew no row.`,
      );
    }

    assert.deepEqual(errors, []);
  } finally {
    await act(() => {
      for (const root of roots) root.unmount();
    });
    body.replaceChildren();
  }
});
