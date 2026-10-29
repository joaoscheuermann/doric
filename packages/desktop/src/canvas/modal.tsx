// `modal.tsx` — a node's canvas expanded over the conversation (spec D17).
//
// A thin controlled wrapper over base-ui's Dialog, portaled through the
// window's portal container: a backdrop, a panel 12px from the window's edges
// and a close button in the top-right corner of the header band. The modal
// never closes itself: every way out (`Esc`, a press on the backdrop, the close
// button) is a request its owner answers by changing `open`. An `Esc` a
// descendant already took (default-prevented) is no request, so the canvas's
// own `Esc` (closing an input, disarming the comment tool) comes first.

import { Dialog } from '@base-ui/react/dialog';
import { XIcon } from 'lucide-react';
import {
  type JSX,
  type KeyboardEvent,
  type ReactNode,
  useRef,
  useState,
} from 'react';

import { Button } from '../components/button.js';
import { usePortalContainer } from '../portal-container.js';

export type CanvasModalCloseReason = 'escape' | 'backdrop' | 'close-button';

export interface CanvasModalProps {
  readonly open: boolean;
  /** The dialog's accessible title (the artifact's title). */
  readonly title: string;
  /** A request to close. The owner decides: sets `open` false, or not. An `Esc` a descendant already default-prevented is no request. */
  readonly onCloseRequest: (reason: CanvasModalCloseReason) => void;
  /** Keys the owner handles; only with focus inside the modal, never from input, textarea or [contenteditable]. */
  readonly onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
  readonly children: ReactNode;
}

/** Whether a key typed at `target` belongs to a text field. */
const typedInText = (target: EventTarget): boolean =>
  target instanceof HTMLElement &&
  (target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.isContentEditable);

/**
 * The canvas modal: `role="dialog"` named by `title`, a backdrop
 * (`canvas-modal-backdrop`), the panel (`canvas-modal`, inset 12px), the
 * focusable content root (`canvas-modal-content`, focused on opening) and the
 * close button (`canvas-modal-close`, `Fechar`). Closing returns the focus to
 * the element focused when it opened, while that element is still connected.
 */
export function CanvasModal({
  open,
  title,
  onCloseRequest,
  onKeyDown,
  children,
}: CanvasModalProps): JSX.Element {
  const container = usePortalContainer();
  const content = useRef<HTMLDivElement>(null);
  // The element focused when `open` became true: where the focus returns.
  const [wasOpen, setWasOpen] = useState(open);
  const [openedFrom, setOpenedFrom] = useState<Element | null>(() =>
    open ? document.activeElement : null,
  );
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setOpenedFrom(document.activeElement);
  }

  return (
    <Dialog.Root
      open={open}
      modal
      onOpenChange={(_next, details) => {
        details.cancel();
        switch (details.reason) {
          case 'escape-key':
            if (!details.event.defaultPrevented) onCloseRequest('escape');
            return;
          case 'outside-press':
            onCloseRequest('backdrop');
            return;
          case 'close-press':
            onCloseRequest('close-button');
            return;
          default:
            return;
        }
      }}
    >
      <Dialog.Portal container={container}>
        <Dialog.Backdrop
          data-testid="canvas-modal-backdrop"
          className="fixed inset-0 z-50 bg-black/40"
        />
        <Dialog.Popup
          data-testid="canvas-modal"
          className="fixed inset-3 z-50 overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10 outline-none"
          initialFocus={content}
          finalFocus={() =>
            openedFrom instanceof HTMLElement && openedFrom.isConnected
              ? openedFrom
              : true
          }
          onKeyDown={(event) => {
            if (onKeyDown !== undefined && !typedInText(event.target)) {
              onKeyDown(event);
            }
          }}
        >
          <Dialog.Title className="sr-only">{title}</Dialog.Title>
          <div
            ref={content}
            data-testid="canvas-modal-content"
            tabIndex={-1}
            className="relative h-full w-full outline-none"
          >
            {children}
          </div>
          <Dialog.Close
            data-testid="canvas-modal-close"
            aria-label="Fechar"
            className="absolute top-1 right-1.5 z-40"
            render={<Button variant="ghost" size="icon-sm" />}
          >
            <XIcon aria-hidden="true" />
          </Dialog.Close>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
