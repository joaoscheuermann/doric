// `comment-overlay.tsx` — what the comment flow draws over the canvas: the
// pins of the artifact's threads and drafts, the inline input of a comment
// being written at its pending pin, and the thread open beside its pin. The
// overlay rides the viewport (its positions follow pan/zoom; its elements are
// not scaled), so it is drawn again with each move of the canvas, while the
// chrome around the canvas is not.

import type { CommentFlow } from './comment-flow.js';
import type { ContentPoint } from './geometry.js';
import {
  type CommentInputProps,
  type CommentPin,
  PinsLayer,
} from './pins-layer.js';
import { ThreadPopover } from './thread-popover.js';
import type { Viewport } from './viewport.js';

/** Copies a text to the clipboard, when the window lets it. */
const copyText = (text: string): void => {
  void globalThis.navigator?.clipboard?.writeText(text).catch(() => undefined);
};

export interface CommentOverlayProps<A> {
  readonly flow: CommentFlow<A>;
  readonly pins: readonly CommentPin[];
  /** Where an anchor's pin sits on the revision on screen. */
  readonly resolve: (
    anchor: A,
    fallback?: ContentPoint,
  ) => ContentPoint | undefined;
  readonly viewport: Viewport;
  readonly area: { readonly width: number; readonly height: number };
  /** Where an anchor points, short, for the popover's title. */
  readonly titleOf: (anchor: A) => string;
  /** The whole anchor on a revision, for the title's tooltip and the copy. */
  readonly textOf: (anchor: A, revision: number | undefined) => string;
  /** Whether the canvas names its Thread, which a resolve is written under. */
  readonly threaded: boolean;
  readonly showResolved: boolean;
  readonly onToggleShowResolved: () => void;
  /**
   * Focuses the canvas and makes it the one the commands act on: the overlay
   * hands it the focus when its open input is confirmed or cancelled, or its
   * open thread is cancelled (Esc) or closed by its close button.
   */
  readonly focusCanvas: () => void;
}

/**
 * What the comment flow draws over the canvas: the pins, the inline input of
 * a new comment at its pending pin, and the open thread beside its pin (its
 * pin's point, else its anchor resolved). A thread can be resolved only while
 * `threaded` and its root names a prompt. Copy goes to the clipboard when the
 * window allows it.
 */
export function CommentOverlay<A>({
  flow,
  pins,
  resolve,
  viewport,
  area,
  titleOf,
  textOf,
  threaded,
  showResolved,
  onToggleShowResolved,
  focusCanvas,
}: CommentOverlayProps<A>) {
  const { open, text, thread } = flow;
  const thenFocus = (close: () => void) => () => {
    focusCanvas();
    close();
  };

  /* The open inline input, positioned on its pin -------------------------------- */

  const input: CommentInputProps | undefined =
    open?.kind !== 'new' || open.data.point === undefined
      ? undefined
      : {
          point:
            resolve(open.data.target.anchor, open.data.point) ??
            open.data.point,
          value: text,
          onChange: flow.setText,
          // Focus moves into the canvas before the field unmounts, so it never leaves the node.
          onConfirm: thenFocus(() => void flow.confirmInput()),
          onCancel: thenFocus(flow.closeInput),
          onBlurOutside: flow.resolveInput,
        };

  /* The open thread, beside its pin ---------------------------------------------- */

  const threadPoint =
    thread === undefined
      ? undefined
      : (pins.find((pin) => pin.key === thread.rootId)?.point ??
        resolve(thread.target.anchor, thread.point));

  return (
    <PinsLayer
      pins={pins}
      viewport={viewport}
      area={area}
      {...(input === undefined ? {} : { input })}
      {...(thread === undefined ? {} : { activeKey: thread.rootId })}
      onOpenPin={flow.openPin}
    >
      {thread === undefined || threadPoint === undefined ? null : (
        <ThreadPopover
          point={threadPoint}
          viewport={viewport}
          area={area}
          pin={thread.pin}
          title={titleOf(thread.target.anchor)}
          anchor={textOf(thread.target.anchor, thread.target.revision)}
          messages={thread.messages}
          {...(thread.sent === undefined
            ? {}
            : { state: thread.sent.state, onResolve: flow.toggleResolved })}
          canResolve={threaded && thread.sent?.root.promptId !== undefined}
          showResolved={showResolved}
          onToggleShowResolved={onToggleShowResolved}
          value={text}
          editing={flow.editing !== undefined}
          onChange={flow.setText}
          onConfirm={() => void flow.confirmInput(false)}
          onCancel={thenFocus(flow.closeInput)}
          onClose={thenFocus(flow.resolveInput)}
          onEdit={flow.editDraft}
          onRemove={flow.removeDraft}
          onCopy={copyText}
        />
      )}
    </PinsLayer>
  );
}
