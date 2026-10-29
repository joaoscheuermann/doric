// The protocol between the app and the diagram measure frame (spec "Frame de
// medida"). The frame is an `<iframe sandbox="allow-scripts">` with an opaque
// origin running `client/frames/diagram.js`; the app and the frame talk over
// one `MessageChannel`.
//
// The handshake: once the frame's runtime listens, it posts one window
// message `{ drawio: DIAGRAM_FRAME_PROTOCOL, kind: 'hello' }` to its parent;
// the app, taking it only from that iframe's `contentWindow`, answers with
// one window message `{ drawio: DIAGRAM_FRAME_PROTOCOL, kind: 'connect' }`
// carrying the channel's second port. The frame then speaks only through
// that port, first with `ready`. The app parses every frame message with
// `parseFrameMessage` before acting on it.
//
// Sizes are CSS px of the SVG at scale 1, relative to the `<svg>`'s top-left.

import { z } from 'zod';

import {
  type DiagramLayoutCell,
  type DiagramTheme,
  diagramLayoutSchema,
} from '../contracts/index.js';
import {
  DIAGRAM_FRAME_PROTOCOL,
  FRAME_ERROR_LIMIT,
} from './frame-constants.js';

export { DIAGRAM_FRAME_PROTOCOL, FRAME_ERROR_LIMIT };

/** The window message the frame's runtime says it listens with. */
export interface FrameHello {
  readonly drawio: typeof DIAGRAM_FRAME_PROTOCOL;
  readonly kind: 'hello';
}

/** The window message that hands the frame its port (in `ports[0]`). */
export interface FrameConnect {
  readonly drawio: typeof DIAGRAM_FRAME_PROTOCOL;
  readonly kind: 'connect';
}

/** Whether a window message's data is a frame's `hello` (extra keys tolerated). Pure. */
export const isFrameHello = (data: unknown): data is FrameHello =>
  typeof data === 'object' &&
  data !== null &&
  (data as { drawio?: unknown }).drawio === DIAGRAM_FRAME_PROTOCOL &&
  (data as { kind?: unknown }).kind === 'hello';

/** App → frame: measure this SVG text, shown in `theme`. */
export interface RenderMessage {
  readonly type: 'render';
  readonly version: typeof DIAGRAM_FRAME_PROTOCOL;
  readonly svg: string;
  readonly theme: DiagramTheme;
}

/** Frame → app, over the port. */
export type FrameMessage =
  /** The frame took the port and answers renders from now on. */
  | { readonly type: 'ready'; readonly version: typeof DIAGRAM_FRAME_PROTOCOL }
  /** The answer to one render: the `<svg>`'s size and one box per `[data-cell-id]`, in document order. */
  | {
      readonly type: 'rendered';
      readonly width: number;
      readonly height: number;
      readonly cells: readonly DiagramLayoutCell[];
    }
  /** The answer to one render the frame could not parse or measure; at most FRAME_ERROR_LIMIT characters. */
  | { readonly type: 'error'; readonly message: string };

/**
 * The closed wire shape of `FrameMessage`: strict objects (no extra keys);
 * `ready` only with `version` DIAGRAM_FRAME_PROTOCOL; `rendered` with the
 * rules of `diagramLayoutSchema` (finite numbers ≥ 0, non-empty cell ids, at
 * most MAX_CELLS cells); `error` with a `message` of at most
 * FRAME_ERROR_LIMIT (4096) characters (`.max(4096)`, as Papercraft's) — a
 * longer one does not parse.
 */
export const frameMessageSchema: z.ZodType<FrameMessage> = z.discriminatedUnion(
  'type',
  [
    z
      .object({
        type: z.literal('ready'),
        version: z.literal(DIAGRAM_FRAME_PROTOCOL),
      })
      .strict(),
    diagramLayoutSchema.extend({ type: z.literal('rendered') }).strict(),
    z
      .object({
        type: z.literal('error'),
        message: z.string().max(FRAME_ERROR_LIMIT),
      })
      .strict(),
  ],
);

/** A frame message, or undefined when `data` does not match `frameMessageSchema`. Pure; never throws. */
export const parseFrameMessage: (data: unknown) => FrameMessage | undefined = (
  data,
) => {
  const parsed = frameMessageSchema.safeParse(data);

  return parsed.success ? parsed.data : undefined;
};

/**
 * The frame document that runs the frame `entry`:
 * `doric://app/frame/index.html?entry=${encodeURIComponent(entry)}`. Pure.
 */
export const frameDocumentUrl: (entry: string) => string = (entry) =>
  `doric://app/frame/index.html?entry=${encodeURIComponent(entry)}`;
