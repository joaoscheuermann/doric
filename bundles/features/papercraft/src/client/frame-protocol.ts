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

import { z } from 'zod';

import {
  NODE_TEXT_LIMIT,
  PROGRAM_PROTOCOL,
  PROTOCOL,
  SCENE_NODE_LIMIT,
} from './frame-constants.js';

export { NODE_TEXT_LIMIT, PROGRAM_PROTOCOL, PROTOCOL, SCENE_NODE_LIMIT };

/**
 * A frame entry's protocol: 1 for artifact previews (`frames/preview.ts`), 2
 * for papercraft programs (`frames/openui.ts`, D6). Each end speaks only its
 * own and drops a message of the other.
 */
export type FrameProtocol = typeof PROTOCOL | typeof PROGRAM_PROTOCOL;

/** The window message a frame's runtime says it listens with. */
export interface HelloMessage {
  readonly papercraft: FrameProtocol;
  readonly kind: 'hello';
}

/**
 * Whether a window message is a frame's `hello` of `protocol` (1 when
 * absent). A `hello` of the other protocol is not one.
 */
export const isHello = (
  data: unknown,
  protocol: FrameProtocol = PROTOCOL,
): data is HelloMessage =>
  typeof data === 'object' &&
  data !== null &&
  (data as { papercraft?: unknown }).papercraft === protocol &&
  (data as { kind?: unknown }).kind === 'hello';

/** The window message that hands the frame its port. */
export interface ConnectMessage {
  readonly papercraft: FrameProtocol;
  readonly kind: 'connect';
}

/** The `connect` message of `protocol`: `{ papercraft: protocol, kind: 'connect' }`. */
export const connectMessage = (protocol: FrameProtocol): ConnectMessage => ({
  papercraft: protocol,
  kind: 'connect',
});

export type PreviewTheme = 'light' | 'dark';

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

/** A compiled module the program frame imports: D14's URLs. */
export interface ProgramModule {
  /** `doric://app/papercraft-modules/<dir>/index.js`. */
  readonly module: string;
  /** `doric://app/papercraft-modules/<dir>/index.css`, when the module has a sheet. */
  readonly styles?: string;
}

/** App → frame, protocol 2 (D6). */
export type ProgramAppMessage =
  | {
      readonly kind: 'init';
      readonly theme: PreviewTheme;
      readonly capture: InputCapture;
      /** The bound repository library; absent when the answer is `none` or `failed`. */
      readonly library?: ProgramModule;
    }
  | {
      /**
       * Repeatable on a mounted frame: sent when `text`, `streaming` or
       * `exports` changes. A new message never resets the program's local
       * state.
       */
      readonly kind: 'program';
      readonly text: string;
      readonly streaming: boolean;
      /**
       * `Export` builds by `<path>#<name>` (`<path>#` without a name); a key
       * absent here draws a placeholder.
       */
      readonly exports: Readonly<Record<string, ProgramModule>>;
    }
  | Extract<
      AppMessage,
      {
        readonly kind:
          | 'theme'
          | 'capture'
          | 'hidden'
          | 'cursor'
          | 'measure'
          | 'dispose';
      }
    >;

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

/** The messages both protocols share, unchanged. */
const sharedMessages = [
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
] as const;

const protocolOneSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('ready'), protocol: z.literal(PROTOCOL) })
    .strict(),
  z
    .object({
      kind: z.literal('scene'),
      nodes: z.array(sceneNode).max(SCENE_NODE_LIMIT),
    })
    .strict(),
  ...sharedMessages,
]);

/** Frame → app, protocol 1. */
export type FrameMessage = z.output<typeof protocolOneSchema>;

/**
 * Protocol 2's scene node (D6): protocol 1's fields without `stamp`, plus the
 * nearest statement wrapper's names, each matching
 * `^[A-Za-z_$][A-Za-z0-9_$]{0,63}$`. A statement's box is the union of its
 * children's boxes.
 */
export type ProgramSceneNodeData = Omit<SceneNodeData, 'stamp'> & {
  readonly statement?: string;
  readonly component?: string;
};

/**
 * The renderer's errors (protocol 2): at most 50, each `message` at most
 * 1,024 characters; sent again with `[]` once all are resolved.
 */
export interface FrameErrorsMessage {
  readonly kind: 'errors';
  readonly errors: readonly {
    readonly code: string;
    readonly statementId?: string;
    readonly message: string;
  }[];
}

const statementName = z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/);

/** Protocol 2's scene node: no `stamp`, the nearest statement wrapper's names. */
const programSceneNode = sceneNode
  .omit({ stamp: true })
  .extend({
    statement: statementName.optional(),
    component: statementName.optional(),
  })
  .strict();

const protocolTwoSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('ready'),
      protocol: z.literal(PROGRAM_PROTOCOL),
    })
    .strict(),
  z
    .object({
      kind: z.literal('scene'),
      nodes: z.array(programSceneNode).max(SCENE_NODE_LIMIT),
    })
    .strict(),
  z
    .object({
      kind: z.literal('errors'),
      errors: z
        .array(
          z
            .object({
              code: z.string().min(1).max(64),
              statementId: statementName.optional(),
              message: z.string().max(1024),
            })
            .strict(),
        )
        .max(50),
    })
    .strict(),
  ...sharedMessages,
]);

/**
 * Frame → app, protocol 2 (D6): protocol 1's `mounted`, `size`, `pointer`,
 * `wheel`, `key`, `focus` and `error` unchanged; `ready` carrying 2; `scene`
 * with `ProgramSceneNodeData`; `errors`. No `action` message.
 */
export type ProgramFrameMessage =
  | Exclude<FrameMessage, { readonly kind: 'ready' | 'scene' }>
  | { readonly kind: 'ready'; readonly protocol: typeof PROGRAM_PROTOCOL }
  | {
      readonly kind: 'scene';
      readonly nodes: readonly ProgramSceneNodeData[];
    }
  | FrameErrorsMessage;

/**
 * The schema the app validates a frame's messages with, one per protocol,
 * built from the shared parts. Strict: an unknown field or kind fails.
 */
export function frameMessageSchema(
  protocol: typeof PROTOCOL,
): z.ZodType<FrameMessage>;
export function frameMessageSchema(
  protocol: typeof PROGRAM_PROTOCOL,
): z.ZodType<ProgramFrameMessage>;
export function frameMessageSchema(
  protocol: FrameProtocol,
): z.ZodType<FrameMessage | ProgramFrameMessage>;
export function frameMessageSchema(
  protocol: FrameProtocol,
): z.ZodType<FrameMessage | ProgramFrameMessage> {
  return protocol === PROTOCOL ? protocolOneSchema : protocolTwoSchema;
}

/**
 * A message from a frame of `protocol` (1 when absent), or undefined when it
 * does not parse under that protocol's schema. Never throws for bad data.
 */
export function frameMessage(
  data: unknown,
  protocol?: typeof PROTOCOL,
): FrameMessage | undefined;
export function frameMessage(
  data: unknown,
  protocol: typeof PROGRAM_PROTOCOL,
): ProgramFrameMessage | undefined;
export function frameMessage(
  data: unknown,
  protocol: FrameProtocol,
): FrameMessage | ProgramFrameMessage | undefined;
export function frameMessage(
  data: unknown,
  protocol: FrameProtocol = PROTOCOL,
): FrameMessage | ProgramFrameMessage | undefined {
  const parsed = frameMessageSchema(protocol).safeParse(data);
  return parsed.success ? parsed.data : undefined;
}

/** The frame document a preview loads, running the bundle's frame `entry`. */
export const frameDocumentUrl = (entry: string): string =>
  `doric://app/frame/index.html?entry=${encodeURIComponent(entry)}`;
