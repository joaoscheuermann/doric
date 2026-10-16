/**
 * `PortalContainerProvider` sends the portaled content of `desktop/ui`'s
 * overlays into the container it names, so a React root mounted inside a
 * shadow root (a Papercraft preview) keeps its overlays there. Outside a
 * provider an overlay portals into the document body, as before, and a
 * `container` a caller passes to an overlay's portal still wins.
 *
 * Contract matrix:
 * - an open Popover and an open Dialog under the provider render their
 *   content in the named container, including one inside a shadow root;
 * - with no provider, the content renders in the document body;
 * - a `container` given to `DialogPortal` wins over the provider's.
 *
 * The imports resolve through the package's export map, so this exercises
 * the files the windows load.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { Window } from 'happy-dom';
import type { ReactNode } from 'react';

const window = new Window();
const installed = [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLButtonElement',
  'HTMLAnchorElement',
  'HTMLTextAreaElement',
  'HTMLSelectElement',
  'SVGElement',
  'ShadowRoot',
  'DocumentFragment',
  'Element',
  'Node',
  'NodeFilter',
  'Event',
  'CustomEvent',
  'FocusEvent',
  'KeyboardEvent',
  'PointerEvent',
  'MouseEvent',
  'MutationObserver',
  'ResizeObserver',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
] as const;

let ui: typeof import('desktop/ui/portal-container');
let popover: typeof import('desktop/ui/popover');
let dialog: typeof import('desktop/ui/dialog');
let createRoot: typeof import('react-dom/client').createRoot;
let createElement: typeof import('react').createElement;
let act: (callback: () => void | Promise<void>) => Promise<void>;

before(async () => {
  for (const name of installed) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: (window as unknown as Record<string, unknown>)[name],
      writable: true,
    });
  }
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const react = await import('react');
  act = react.act as typeof act;
  createElement = react.createElement;
  ({ createRoot } = await import('react-dom/client'));
  [ui, popover, dialog] = await Promise.all([
    import('desktop/ui/portal-container'),
    import('desktop/ui/popover'),
    import('desktop/ui/dialog'),
  ]);
});

after(async () => {
  await window.happyDOM.abort();
  await window.happyDOM.close();
});

/** Renders `node` into a fresh element of the document; returns its unmount. */
const render = async (node: ReactNode): Promise<() => Promise<void>> => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(() => root.render(node));

  return async () => {
    await act(() => root.unmount());
    host.remove();
  };
};

const openPopover = (): ReactNode =>
  createElement(
    popover.Popover,
    { open: true },
    createElement(popover.PopoverTrigger, null, 'More'),
    createElement(
      popover.PopoverContent,
      null,
      createElement('p', { id: 'popover-body' }, 'popover'),
    ),
  );

const openDialog = (content?: ReactNode): ReactNode =>
  createElement(
    dialog.Dialog,
    { open: true },
    content ??
      createElement(
        dialog.DialogContent,
        null,
        createElement(dialog.DialogTitle, null, 'Rename'),
        createElement(dialog.DialogDescription, null, 'Rename the file.'),
        createElement('p', { id: 'dialog-body' }, 'dialog'),
      ),
  );

const portalTarget = (): HTMLElement => {
  const container = document.createElement('div');
  container.setAttribute('data-target', '');
  document.body.append(container);

  return container;
};

const provide = (container: HTMLElement, node: ReactNode): ReactNode =>
  createElement(ui.PortalContainerProvider, { container }, node);

describe('PortalContainerProvider', () => {
  test("an open Popover renders its content in the provider's container", async () => {
    const container = portalTarget();
    const unmount = await render(provide(container, openPopover()));

    assert.equal(
      container.querySelector('#popover-body')?.textContent,
      'popover',
    );
    await unmount();
    container.remove();
  });

  test('an open Dialog renders in a container inside a shadow root', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const container = document.createElement('div');
    shadow.append(container);
    const unmount = await render(provide(container, openDialog()));

    const body = container.querySelector('#dialog-body');
    assert.equal(body?.textContent, 'dialog');
    assert.equal(body?.getRootNode(), shadow);
    assert.equal(document.querySelector('#dialog-body'), null);
    await unmount();
    host.remove();
  });

  test('without a provider the content renders in the document body', async () => {
    const unmount = await render(openPopover());

    const body = document.querySelector('#popover-body');
    assert.equal(body?.textContent, 'popover');
    // Portaled: not inside the element the tree was rendered into.
    assert.equal(
      body?.closest('[data-radix-popper-content-wrapper]')?.parentElement,
      document.body,
    );
    await unmount();
  });

  test("a container passed to DialogPortal wins over the provider's", async () => {
    const provided = portalTarget();
    const explicit = portalTarget();
    const unmount = await render(
      provide(
        provided,
        openDialog(
          createElement(
            dialog.DialogPortal,
            { container: explicit },
            createElement('p', { id: 'explicit-body' }, 'explicit'),
          ),
        ),
      ),
    );

    assert.equal(
      explicit.querySelector('#explicit-body')?.textContent,
      'explicit',
    );
    assert.equal(provided.querySelector('#explicit-body'), null);
    await unmount();
    provided.remove();
    explicit.remove();
  });
});
