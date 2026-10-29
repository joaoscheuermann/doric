// The canvas modal (`desktop/ui/canvas`): a node's canvas expanded over the
// conversation (spec D17, Fase 1a). The modal is controlled: it only asks its
// owner to close (`onCloseRequest` with the reason) and never closes itself;
// the keys it forwards to its owner skip the text fields. The header a modal
// carries is the 36px band without a titlebar height or a drag region.
//
// Contract matrix:
// - M1 open → a dialog named by the title, a backdrop and the 12px-inset
//   panel; closed → nothing;
// - M2 under a PortalContainerProvider → the panel in that container;
// - M3 Esc → one 'escape' request, the dialog stays while `open` stays true;
// - M4 an Esc a descendant already took → no request;
// - M5 a press on the backdrop → 'backdrop'; inside the panel → none;
// - M6 the close button (`Fechar`) → 'close-button';
// - M7 opening focuses the content; closing returns the focus to where it was;
// - M8 onKeyDown gets keys from a button or a div, not from text fields;
// - M9 CanvasHeader host="modal" has no drag region, no titlebar height, no
//   `expandir`, and the send button with drafts.

import { closeDom, act, settle } from './support/dom.js';

import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';

import {
  CanvasHeader,
  type CanvasHeaderProps,
  CanvasModal,
  type CanvasModalCloseReason,
  type CanvasModalProps,
} from 'desktop/ui/canvas';
import { PortalContainerProvider } from 'desktop/ui/portal-container';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

after(closeDom);

/** Renders `node` into a fresh element of the document. */
const render = async (node: ReactNode) => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(() => root.render(node));
  await settle();

  return {
    host,
    rerender: async (next: ReactNode) => {
      await act(() => root.render(next));
      await settle();
    },
    unmount: async () => {
      await act(() => root.unmount());
      host.remove();
    },
  };
};

const byTestId = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

const need = (id: string): HTMLElement => {
  const element = byTestId(id);
  assert.ok(element !== null, `no [data-testid="${id}"]`);
  return element;
};

/** A modal whose close requests are recorded and change nothing. */
const modal = (
  props: Partial<CanvasModalProps> = {},
): {
  readonly requests: CanvasModalCloseReason[];
  readonly node: (more?: Partial<CanvasModalProps>) => ReactNode;
} => {
  const requests: CanvasModalCloseReason[] = [];
  const node = (more: Partial<CanvasModalProps> = {}) => (
    <CanvasModal
      open
      title="Fluxo de checkout"
      onCloseRequest={(reason) => requests.push(reason)}
      {...props}
      {...more}
    >
      {more.children ?? props.children ?? <p id="modal-body">canvas</p>}
    </CanvasModal>
  );
  return { requests, node };
};

const keyDown = async (target: Element, key: string): Promise<KeyboardEvent> => {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
  });
  await act(() => {
    target.dispatchEvent(event);
  });
  await settle();
  return event;
};

/** A full pointer press: down, up and the click. */
const press = async (target: Element): Promise<void> => {
  await act(() => {
    const init = { bubbles: true, cancelable: true, button: 0 };
    target.dispatchEvent(new PointerEvent('pointerdown', init));
    target.dispatchEvent(new MouseEvent('mousedown', init));
    target.dispatchEvent(new PointerEvent('pointerup', init));
    target.dispatchEvent(new MouseEvent('mouseup', init));
    target.dispatchEvent(new MouseEvent('click', init));
  });
  await settle();
};

describe('CanvasModal', () => {
  test('M1 open shows a dialog named by the title over a backdrop, 12px from the edges; closed shows nothing', async () => {
    const { node } = modal();
    const view = await render(node());

    const dialog = document.querySelector('[role="dialog"]');
    assert.ok(dialog !== null, 'no dialog');
    const labelledBy = dialog.getAttribute('aria-labelledby');
    assert.ok(labelledBy !== null, 'the dialog has no accessible name');
    assert.equal(
      document.getElementById(labelledBy)?.textContent,
      'Fluxo de checkout',
    );
    assert.ok(byTestId('canvas-modal-backdrop') !== null, 'no backdrop');
    assert.ok(need('canvas-modal').classList.contains('inset-3'));
    assert.equal(document.querySelector('#modal-body')?.textContent, 'canvas');

    await view.rerender(node({ open: false }));
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(byTestId('canvas-modal'), null);
    assert.equal(byTestId('canvas-modal-backdrop'), null);
    assert.equal(document.querySelector('#modal-body'), null);
    await view.unmount();
  });

  test('M2 under a PortalContainerProvider the panel renders in its container', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const { node } = modal();
    const view = await render(
      <PortalContainerProvider container={container}>
        {node()}
      </PortalContainerProvider>,
    );

    assert.ok(container.contains(need('canvas-modal')));
    await view.unmount();
    container.remove();
  });

  test('M3 Esc asks to close once; the dialog stays while open stays true', async () => {
    const { requests, node } = modal();
    const view = await render(node());

    await keyDown(need('canvas-modal-content'), 'Escape');
    assert.deepEqual(requests, ['escape']);
    assert.ok(document.querySelector('[role="dialog"]') !== null);
    assert.ok(byTestId('canvas-modal') !== null);
    await view.unmount();
  });

  test('M4 an Esc a descendant already took is no close request', async () => {
    const { requests, node } = modal();
    const view = await render(
      node({
        children: (
          <button
            type="button"
            id="taker"
            onKeyDown={(event) => {
              if (event.key === 'Escape') event.preventDefault();
            }}
          >
            taker
          </button>
        ),
      }),
    );

    const taker = document.querySelector('#taker');
    assert.ok(taker !== null);
    await keyDown(taker, 'Escape');
    assert.deepEqual(requests, []);
    await view.unmount();
  });

  test('M5 a press on the backdrop asks to close; a press inside the panel does not', async () => {
    const { requests, node } = modal();
    const view = await render(node());

    await press(need('canvas-modal-content'));
    assert.deepEqual(requests, []);

    await press(need('canvas-modal-backdrop'));
    assert.deepEqual(requests, ['backdrop']);
    await view.unmount();
  });

  test('M6 the close button asks to close', async () => {
    const { requests, node } = modal();
    const view = await render(node());

    const close = need('canvas-modal-close');
    assert.equal(close.getAttribute('aria-label'), 'Fechar');
    await press(close);
    assert.deepEqual(requests, ['close-button']);
    await view.unmount();
  });

  test('M7 opening focuses the content; the owner closing returns the focus to where it was', async () => {
    const opener = document.createElement('button');
    opener.textContent = 'expandir';
    document.body.append(opener);
    opener.focus();
    assert.equal(document.activeElement, opener);

    const { node } = modal();
    const view = await render(node({ open: false }));
    await view.rerender(node({ open: true }));
    await settle();
    assert.equal(document.activeElement, need('canvas-modal-content'));

    await view.rerender(node({ open: false }));
    await settle();
    assert.equal(document.activeElement, opener);
    await view.unmount();
    opener.remove();
  });

  test('M8 onKeyDown gets the keys of a button or a div, never of a text field', async () => {
    const keys: string[] = [];
    const { node } = modal();
    const view = await render(
      node({
        onKeyDown: (event) =>
          keys.push(`${event.key}@${(event.target as HTMLElement).id}`),
        children: (
          <>
            <button type="button" id="b">
              b
            </button>
            <div id="d" tabIndex={-1}>
              d
            </div>
            <input id="i" />
            <textarea id="t" />
            <div id="e" contentEditable suppressContentEditableWarning>
              e
            </div>
          </>
        ),
      }),
    );

    const at = (id: string): Element => {
      const element = document.getElementById(id);
      assert.ok(element !== null, `no #${id}`);
      return element;
    };
    await keyDown(at('b'), 'v');
    await keyDown(at('d'), 'h');
    await keyDown(at('i'), 'v');
    await keyDown(at('t'), 'v');
    await keyDown(at('e'), 'v');
    assert.deepEqual(keys, ['v@b', 'h@d']);
    await view.unmount();
  });
});

describe('CanvasHeader host', () => {
  const header = (more: Partial<CanvasHeaderProps>): ReactNode => (
    <CanvasHeader
      host="modal"
      title="Fluxo de checkout"
      revision={2}
      canExpand
      onExpand={() => undefined}
      commentActive={false}
      canComment
      commentCount={0}
      onToggleComment={() => undefined}
      draftCount={0}
      onSend={() => undefined}
      {...more}
    />
  );

  const classes = (): string[] => [...need('papercraft-header').classList];

  test('M9 in the modal: no drag region, no titlebar height, no expandir, and the send button with drafts', async () => {
    const view = await render(header({ host: 'modal', draftCount: 2 }));

    assert.ok(!classes().includes('[-webkit-app-region:drag]'));
    assert.ok(!classes().includes('h-(--doric-titlebar-height)'));
    assert.equal(byTestId('papercraft-expand'), null);
    assert.match(need('papercraft-send').textContent, /Enviar ao agente \(2\)/);
    await view.unmount();
  });
});
