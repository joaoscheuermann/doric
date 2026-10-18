// `pins-layer.tsx` — the comment pins and the inline comment input, in light
// DOM, over the shadow root (spec: "O node da conversa", the comment flow).
//
// A pin is a teardrop balloon — round except its bottom-left corner, which is
// the tip and sits exactly on the point it annotates. It wears its number and
// says where its thread stands:
//
//   - the pin of a comment being written: a solid primary teardrop marking
//     where the comment will land, with the input beside it;
//   - a draft (its first comment still in the composer stack): a dashed
//     outline;
//   - an open thread: the primary fill, with the count of its replies;
//   - a thread awaiting the reader (the agent spoke last): the warning fill
//     with a `?`;
//   - a resolved thread: muted, with a green `✓` (shown only while the reader
//     shows the resolved ones).
//
// The pins and the input are an overlay above the transformed content: they
// are not scaled, their positions follow pan/zoom (content coordinates through
// the viewport), and the input sits to the right of its pin — or to its left
// when the canvas has no room — never over it, kept inside the canvas. The
// input is a popover with the thread's surface (the popover colours, border,
// radius and shadow), so it reads over any preview. The shapes and fills are
// component rules over the theme tokens (styles.css); utilities here only
// place things. What confirming the note means is the surface's: a new draft
// joins the stack.

import { type CommentPinState, CommentPin as Pin } from 'desktop/ui/comment-pin';
import { cn } from 'desktop/ui/utils';
import { type ReactNode, useRef } from 'react';

import type { ThreadState } from '../domain/preview-state.js';
import { CommentField } from './comment-field.js';
import type { Viewport } from './viewport.js';

/** The attribute every overlay element carries: the canvas ignores its clicks. */
export const OVERLAY_ATTRIBUTE = 'data-papercraft-overlay';

/** One pin on the canvas: a thread's root, sent or still a draft. */
export interface CommentPin {
  /** The root's id: the comment's, or the draft item's (its id once sent). */
  readonly key: string;
  readonly pin: number;
  /** Where the pin's tip sits, in content coordinates. */
  readonly point: { readonly x: number; readonly y: number };
  /** `draft` while its first comment is in the stack; the thread's state once sent. */
  readonly state: 'draft' | ThreadState;
  /** How many replies the thread holds. */
  readonly replies: number;
  /** The root's note, for the pin's tooltip. */
  readonly note: string;
  /**
   * Whether the anchor no longer resolves on the revision on screen and
   * recorded no point: the pin is stacked by the content's edge instead.
   */
  readonly detached?: boolean;
}

/** The pin of a comment being written. */
const PENDING_SIZE = 32;
/** The pin of a comment already there: the shared pin's `md`. */
const PIN_SIZE = 24;
const INPUT_GAP = 10;
const INPUT_WIDTH = 280;
/**
 * The input popover's height while its field holds one line: the 28px field
 * and send button, the popover's 6px padding and its 1px border.
 */
export const INPUT_HEIGHT = 28 + 2 * 6 + 2;

/** A content point, as the surface pixels the overlay positions with. */
export const surfacePoint = (
  point: { readonly x: number; readonly y: number },
  viewport: Viewport,
) => ({
  x: point.x * viewport.scale + viewport.tx,
  y: point.y * viewport.scale + viewport.ty,
});

/** The box of a pin whose tip (bottom-left corner) is on `at`. */
const pinBox = (
  at: { readonly x: number; readonly y: number },
  size: number,
) => ({
  left: `${String(at.x)}px`,
  top: `${String(at.y - size)}px`,
  width: `${String(size)}px`,
  height: `${String(size)}px`,
});

/** The pin of the comment being written: where it will land. */
function PendingPin({
  point,
  viewport,
}: {
  readonly point: { readonly x: number; readonly y: number };
  readonly viewport: Viewport;
}) {
  return (
    <span
      data-testid="papercraft-pending-pin"
      aria-hidden="true"
      className="papercraft-pin-pending pointer-events-none absolute z-20 rounded-[9999px_9999px_9999px_0] shadow-md"
      style={pinBox(surfacePoint(point, viewport), PENDING_SIZE)}
    />
  );
}

const STATE_LABEL: Record<CommentPin['state'], string> = {
  draft: 'rascunho',
  open: 'aberto',
  await: 'aguardando você',
  done: 'resolvido',
};

/** What a detached pin says of itself. */
const DETACHED_LABEL = 'elemento não encontrado nesta revisão';

/** The pin's tooltip: its note, and why it sits apart when it is detached. */
const titleOf = (pin: CommentPin): string | undefined => {
  const parts = [
    ...(pin.detached === true ? [DETACHED_LABEL] : []),
    ...(pin.note === '' ? [] : [pin.note]),
  ];

  return parts.length === 0 ? undefined : parts.join(' · ');
};

/** The pin of a comment already there: its number, its state. */
function Balloon({
  pin,
  active,
  viewport,
  onOpen,
}: {
  readonly pin: CommentPin;
  readonly active: boolean;
  readonly viewport: Viewport;
  readonly onOpen?: () => void;
}) {
  return (
    <Pin
      state={pin.state as CommentPinState}
      size="md"
      data-testid="papercraft-pin"
      data-pin={String(pin.pin)}
      data-active={active ? 'true' : undefined}
      data-detached={pin.detached === true ? 'true' : undefined}
      aria-label={`Comentário ${String(pin.pin)} · ${STATE_LABEL[pin.state]}${
        pin.detached === true ? ` · ${DETACHED_LABEL}` : ''
      }`}
      title={titleOf(pin)}
      className={cn(
        'pointer-events-auto absolute z-20',
        pin.detached === true && 'papercraft-pin-detached',
        active && 'papercraft-pin-active',
      )}
      style={pinBox(surfacePoint(pin.point, viewport), PIN_SIZE)}
      onClick={(event) => {
        event.stopPropagation();
        onOpen?.();
      }}
    >
      {String(pin.pin)}
    </Pin>
  );
}

/** What the inline input of a new comment shows and answers. */
export interface CommentInputProps {
  /** The content point the input's pin sits on. */
  readonly point: { readonly x: number; readonly y: number };
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  /** Confirms the note and sends the stack (`Cmd/Ctrl+Enter`). */
  readonly onSend: () => void;
  /** Focus left the input for outside the canvas. */
  readonly onBlurOutside: () => void;
}

/**
 * Where the input goes: right of the pin, or left of it when the canvas has
 * no room there, its top level with the pin's, kept inside the canvas.
 */
export const inputPlacement = (
  at: { readonly x: number; readonly y: number },
  area: { readonly width: number; readonly height: number },
): { readonly left: number; readonly top: number } => {
  const right = at.x + PENDING_SIZE + INPUT_GAP;
  const left =
    right + INPUT_WIDTH <= area.width - 4 || area.width <= 0
      ? right
      : Math.max(4, at.x - INPUT_GAP - INPUT_WIDTH);
  const top = Math.max(
    4,
    Math.min(
      at.y - PENDING_SIZE - (INPUT_HEIGHT - PENDING_SIZE) / 2,
      area.height - INPUT_HEIGHT - 4,
    ),
  );

  return { left, top };
};

/** The pin and the input beside it, clamped inside the canvas. */
function CommentInput({
  point,
  value,
  viewport,
  area,
  onChange,
  onConfirm,
  onCancel,
  onSend,
  onBlurOutside,
}: CommentInputProps & {
  readonly viewport: Viewport;
  readonly area: { readonly width: number; readonly height: number };
}) {
  const field = useRef<HTMLTextAreaElement>(null);
  const placement = inputPlacement(surfacePoint(point, viewport), area);

  return (
    <>
      <PendingPin point={point} viewport={viewport} />
      <div
        data-testid="papercraft-comment-input"
        className="papercraft-comment-input pointer-events-auto absolute z-30 rounded-lg border border-border bg-popover p-1.5 text-popover-foreground"
        style={{
          left: `${String(placement.left)}px`,
          top: `${String(placement.top)}px`,
          width: `${String(INPUT_WIDTH)}px`,
        }}
      >
        <CommentField
          fieldRef={field}
          autoFocus
          value={value}
          placeholder="Adicionar comentário"
          confirmTestId="papercraft-comment-confirm"
          onChange={onChange}
          onConfirm={onConfirm}
          onCancel={onCancel}
          onSend={onSend}
          onBlur={(event) => {
            const next = event.relatedTarget as Node | null;
            const overlay = event.currentTarget.closest(
              `[${OVERLAY_ATTRIBUTE}]`,
            );
            const canvas = overlay?.parentElement;

            // Focus that stays on the canvas is the canvas's own gesture
            // (a click there resolves the input); focus that leaves it is a
            // click outside.
            if (next !== null && canvas?.contains(next) === true) return;
            onBlurOutside();
          }}
        />
      </div>
    </>
  );
}

/** Every pin of the revision, the open input and the open thread, over the canvas. */
export function PinsLayer({
  pins,
  viewport,
  area,
  input,
  activeKey,
  onOpenPin,
  children,
}: {
  readonly pins: readonly CommentPin[];
  readonly viewport: Viewport;
  readonly area: { readonly width: number; readonly height: number };
  /** The open inline input of a new comment, when one is open. */
  readonly input?: CommentInputProps;
  /** The pin whose thread is open: it wears the active ring. */
  readonly activeKey?: string;
  readonly onOpenPin?: (pin: CommentPin) => void;
  /** The open thread's popover. */
  readonly children?: ReactNode;
}) {
  return (
    <div
      {...{ [OVERLAY_ATTRIBUTE]: '' }}
      className="pointer-events-none absolute inset-0 z-20"
    >
      {pins.map((pin) => (
        <Balloon
          key={pin.key}
          pin={pin}
          active={pin.key === activeKey}
          viewport={viewport}
          onOpen={() => onOpenPin?.(pin)}
        />
      ))}
      {input === undefined ? null : (
        <CommentInput {...input} viewport={viewport} area={area} />
      )}
      {children}
    </div>
  );
}
