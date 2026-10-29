// The protocol between the app and a preview's frame (docs/architecture/
// bundles/papercraft/isolamento.md). Every preview renders in an
// `<iframe sandbox="allow-scripts">` with an opaque origin; the app and the
// frame talk only over one `MessageChannel` per frame.
//
// The handshake: once the frame's runtime listens, it posts one window
// message `{ papercraft: PROTOCOL, kind: 'hello' }` to its parent; the app,
// taking it only from that iframe's `contentWindow`, answers with one window
// message `{ papercraft: PROTOCOL, kind: 'connect' }` carrying the channel's
// second port. The runtime takes that port and from then on speaks only
// through it, first with `ready`. The app accepts the frame's messages only
// from that port. The frame speaks first because the document's `load` event
// says nothing of the runtime: its boot script imports it afterwards, so a
// `connect` sent on `load` can reach a frame that does not listen yet.
//
// What the app sends is typed here; what the frame sends is the Project's
// code's word, so the app parses every frame message with `frameMessage`
// before acting on it, and drops what does not parse.
//
// Coordinates are CSS pixels of the frame's document, its top-left corner the
// origin: the app scales the iframe with the canvas's `transform`, so a frame
// never measures the zoom.

import type { CanvasTheme as PreviewTheme } from 'desktop/ui/canvas';
import { z } from 'zod';

import {
  NODE_TEXT_LIMIT,
  PROTOCOL,
  SCENE_NODE_LIMIT,
} from './frame-constants.js';

export { NODE_TEXT_LIMIT, PROTOCOL, SCENE_NODE_LIMIT };

/** The window message a frame's runtime says it listens with. */
export interface HelloMessage {
  readonly papercraft: typeof PROTOCOL;
  readonly kind: 'hello';
}

/** Whether a window message is a frame's `hello`. */
export const isHello = (data: unknown): data is HelloMessage =>
  typeof data === 'object' &&
  data !== null &&
  (data as { papercraft?: unknown }).papercraft === PROTOCOL &&
  (data as { kind?: unknown }).kind === 'hello';

/** The window message that hands the frame its port. */
export interface ConnectMessage {
  readonly papercraft: typeof PROTOCOL;
  readonly kind: 'connect';
}

export type { CanvasTheme as PreviewTheme } from 'desktop/ui/canvas';

/** Storybook's layouts, as a revision's `mount` states them. */
export type PreviewLayout = 'centered' | 'padded' | 'fullscreen';

/**
 * Who handles the preview's pointer and keys:
 * - `none`: the preview, natively; the frame still reports `pointer` moves;
 * - `first`: the frame swallows input until the first `pointerdown`, then
 *   behaves as `none` (a node's first click focuses it, it does not reach the
 *   preview);
 * - `all`: the frame swallows input (no click, link or submit reaches the
 *   preview) and reports it, for the canvas's select, comment and pan tools.
 */
export type InputCapture = 'none' | 'first' | 'all';

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export type PseudoKind = '::before' | '::after';

// ---------------------------------------------------------------------------
// App → frame

/** What to render: a revision's module, else its markup (path A). */
export type FrameContent =
  | {
      readonly kind: 'module';
      /** `doric://app/artifacts/<id>@<rev>/index.js`. */
      readonly module: string;
      /** The revision's compiled sheet, when it has one. */
      readonly styles?: string;
      /** Path A's markup, rendered when the module fails to load or mount. */
      readonly fallback?: string;
    }
  | { readonly kind: 'markup'; readonly markup: string };

export type AppMessage =
  | {
      readonly kind: 'init';
      readonly content: FrameContent;
      readonly theme: PreviewTheme;
      readonly capture: InputCapture;
    }
  | { readonly kind: 'theme'; readonly theme: PreviewTheme }
  | { readonly kind: 'capture'; readonly capture: InputCapture }
  /** The ids of the last `scene` whose elements are hidden; `[]` shows all. */
  | { readonly kind: 'hidden'; readonly ids: readonly string[] }
  /**
   * Locks every element of the preview to one cursor: an iframe's cursor
   * comes from its own document, never the app's, so the app names the
   * canvas's (`crosshair`, `grab`, `grabbing`…; a CSS keyword, `default` when
   * absent).
   */
  | {
      readonly kind: 'cursor';
      readonly locked: boolean;
      readonly cursor?: string;
    }
  /** Asks for a fresh `scene` (the canvas resized, a font loaded…). */
  | { readonly kind: 'measure' }
  /** Unmounts the revision; the app removes the iframe next. */
  | { readonly kind: 'dispose' };

// ---------------------------------------------------------------------------
// Frame → app

const finite = z.number().finite();
const rect = z
  .object({
    x: finite,
    y: finite,
    width: finite.nonnegative(),
    height: finite.nonnegative(),
  })
  .strict();
const point = z.object({ x: finite, y: finite }).strict();
const nodeId = z.string().regex(/^n\d{1,4}$/);
const pseudo = z.enum(['::before', '::after']);
const layout = z.enum(['centered', 'padded', 'fullscreen']);

/** One derived element of the rendered preview. */
const sceneNode = z
  .object({
    /** `n0`, `n1`, … in document order, stable within one scene. */
    id: nodeId,
    parentId: nodeId.optional(),
    depth: z.number().int().nonnegative().max(SCENE_NODE_LIMIT),
    tag: z.string().min(1).max(64),
    classes: z.array(z.string().max(256)).max(64),
    /** The element's `id` attribute. */
    elementId: z.string().max(256).optional(),
    /** Its own `data-papercraft-source` (`path:line`), when it carries one. */
    stamp: z.string().max(1024).optional(),
    /** Its text, whitespace collapsed, at most NODE_TEXT_LIMIT characters. */
    text: z.string().max(NODE_TEXT_LIMIT),
    /** Its border box cut to what its clipping ancestors leave visible. */
    bounds: rect,
    /** Its out-of-flow `::before` / `::after` boxes, when it has any. */
    pseudo: z
      .object({ '::before': rect.optional(), '::after': rect.optional() })
      .strict()
      .optional(),
  })
  .strict();

export type SceneNodeData = z.output<typeof sceneNode>;

/** The node under the pointer, as the frame resolved the event's target. */
const target = z
  .object({ nodeId: nodeId.optional(), pseudo: pseudo.optional() })
  .strict();

const modifiers = {
  altKey: z.boolean(),
  ctrlKey: z.boolean(),
  metaKey: z.boolean(),
  shiftKey: z.boolean(),
};

const frameMessageSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('ready'), protocol: z.literal(PROTOCOL) })
    .strict(),
  /** The revision rendered: its module, its markup, or the fallback markup. */
  z
    .object({
      kind: z.literal('mounted'),
      mode: z.enum(['module', 'markup', 'fallback']),
      layout,
    })
    .strict(),
  /** The rendered content's size; `centered` reports its intrinsic width. */
  z
    .object({
      kind: z.literal('size'),
      width: finite.nonnegative(),
      height: finite.nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('scene'),
      nodes: z.array(sceneNode).max(SCENE_NODE_LIMIT),
    })
    .strict(),
  z
    .object({
      kind: z.literal('pointer'),
      type: z.enum(['move', 'down', 'up', 'click', 'leave']),
      point,
      button: z.number().int(),
      buttons: z.number().int(),
      ...target.shape,
      ...modifiers,
    })
    .strict(),
  z
    .object({
      kind: z.literal('wheel'),
      point,
      deltaX: finite,
      deltaY: finite,
      deltaMode: z.number().int(),
      ...modifiers,
    })
    .strict(),
  /** A key the canvas uses (space, `c`, Escape) typed while the frame has focus. */
  z
    .object({
      kind: z.literal('key'),
      type: z.enum(['keydown', 'keyup']),
      key: z.string().max(32),
      code: z.string().max(32),
      repeat: z.boolean(),
      ...modifiers,
    })
    .strict(),
  z.object({ kind: z.literal('focus'), focused: z.boolean() }).strict(),
  /** A render or script error of the preview, which the frame contained. */
  z
    .object({
      kind: z.literal('error'),
      message: z.string().max(4096),
      stack: z.string().max(16_384).optional(),
    })
    .strict(),
]);

export type FrameMessage = z.output<typeof frameMessageSchema>;

/** A message from a frame, or undefined when it is not one. */
export const frameMessage = (data: unknown): FrameMessage | undefined => {
  const parsed = frameMessageSchema.safeParse(data);
  return parsed.success ? parsed.data : undefined;
};

/** The frame document a preview loads, running the bundle's frame `entry`. */
export const frameDocumentUrl = (entry: string): string =>
  `doric://app/frame/index.html?entry=${encodeURIComponent(entry)}`;
