// Public contracts of the `papercraft` bundle (D25: papercraft fences only).
//
// The bundle consumes the contracts of other bundles — `files/v1`,
// `comments/v1` and `runtime.threads/v1` — and keeps structural copies of the
// shapes it uses, as the `threads` client does for `chat.views/v1`: those
// bundles are built separately and this one must not import them at compile
// time. The IDs and shapes are theirs.

import {
  type CallArg,
  type CallScope,
  type Disposable,
  type MethodSpecs,
  ref,
  type StreamListener,
} from 'bundle/contracts';
import { z } from 'zod';

export * from './cache.js';
export * from './chat.js';
export * from './cwd.js';
export * from './programs.js';

/* Files (structural copy of `files/v1`) ----------------------------------- */

/** One file as bounded text, as `files/v1.content` reads it. */
export type FilesContentRead =
  | {
      readonly status: 'read';
      readonly path: string;
      readonly content: string;
      readonly truncated: boolean;
      readonly binary: boolean;
    }
  | { readonly status: 'not_found' | 'not_file' | 'invalid_path' };

/** What a lease-dependent read answers: the value, or why it could not run. */
export type LeaseOutcome<T> =
  | { readonly status: 'ready'; readonly value: T }
  | {
      readonly status: 'pending' | 'unavailable' | 'expired' | 'missing';
    };

/**
 * `files/v1` (host): the Project sandbox reads. Scope is
 * `call.scope.projectId`; no read acquires a lease.
 */
export interface Files {
  /** `encoding: 'base64'` (1.1.0) reads the file's bytes, a font or an image. */
  content(
    input: { readonly path: string; readonly encoding?: 'utf8' | 'base64' },
    call?: CallArg,
  ): Promise<LeaseOutcome<FilesContentRead>>;
}

export const FilesV1 = ref<Files>('files/v1');

/* Comments (structural copy of `comments/v1`) ----------------------------- */

/** The fields every anchor form may carry; each form then requires its own. */
const anchorFields = {
  path: z.string().optional(),
  line: z.number().int().positive().optional(),
  selector: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  label: z.string().optional(),
  text: z.string().optional(),
  /**
   * The `::before` / `::after` of the anchored element that the comment is
   * on; the anchor's `offset` is then relative to that pseudo box. Absent
   * means the element itself. Any other value fails validation.
   */
  pseudo: z.enum(['::before', '::after']).optional(),
};

/**
 * Where in the target a comment sits, validated per form as `comments/v1`
 * validates it: `source` names a `path` (its `line` a positive integer when
 * given), `selector` a `selector`, `point` both `x` and `y`, `range` its
 * `text`.
 */
export const commentAnchorSchema = z.discriminatedUnion('form', [
  z.looseObject({
    ...anchorFields,
    form: z.literal('source'),
    path: z.string().min(1),
  }),
  z.looseObject({
    ...anchorFields,
    form: z.literal('selector'),
    selector: z.string().min(1),
  }),
  z.looseObject({
    ...anchorFields,
    form: z.literal('point'),
    x: z.number(),
    y: z.number(),
  }),
  z.looseObject({
    ...anchorFields,
    form: z.literal('range'),
    text: z.string().min(1),
  }),
]);

export type CommentAnchor = z.output<typeof commentAnchorSchema>;

export const commentTargetSchema = z
  .object({
    kind: z.string().min(1),
    id: z.string().min(1),
    revision: z.number().int().positive().optional(),
    anchor: commentAnchorSchema,
  })
  .strict();

export type CommentTarget = z.output<typeof commentTargetSchema>;

export const commentSchema = z
  .object({
    commentId: z.string().min(1),
    target: commentTargetSchema,
    text: z.string(),
    author: z.string().optional(),
    resolved: z.boolean(),
    createdAt: z.string(),
    /** The root comment this one answers; absent on a root. */
    inReplyTo: z.string().optional(),
  })
  .loose();

export type Comment = z.output<typeof commentSchema>;

/**
 * What `comments/v1.add` carries: the target the comment is about, the text
 * the reader wrote and, optionally, the author. It is also what a kind's
 * `chat.composer/v1` flush answers with — the durable writes the sender
 * performs after the send of a prompt drains the stack.
 */
export interface CommentAddInput {
  readonly target: CommentTarget;
  readonly text: string;
  readonly author?: string;
  /**
   * The id the comment is written under, chosen by the caller (the stack
   * item's id): a retried write with the same id is idempotent.
   */
  readonly commentId?: string;
  /** The root comment this one answers. */
  readonly inReplyTo?: string;
}

/**
 * The comment target kind of a papercraft program (D19): a comment's target is
 * `{ kind: PROGRAM_TARGET_KIND, id: <identity>, revision, anchor }`.
 */
export const PROGRAM_TARGET_KIND = 'papercraft-program';

/** The identity of a target, as `comments/v1.list` filters by it. */
export interface CommentTargetKey {
  readonly kind: string;
  readonly id: string;
  readonly revision?: number;
}

export interface Comments {
  add(input: CommentAddInput, call?: CallArg): Promise<Comment>;
  /** The comments of a target, in the order of the log. */
  list(
    input: { readonly target?: CommentTargetKey; readonly kind?: string },
    call?: CallArg,
  ): Promise<readonly Comment[]>;
  /**
   * Marks one comment of the call's Thread attended (or reopens it), writing
   * `comments.resolved/v1`; the call scope names the Project, the Thread and
   * the prompt the event is written under.
   */
  resolve(
    input: { readonly commentId: string; readonly resolved: boolean },
    call?: CallArg,
  ): Promise<Comment | undefined>;
}

export const CommentsV1 = ref<Comments>('comments/v1');

/* Threads (structural copy of `runtime.threads/v1`'s watch) --------------- */

/** One durable event of a Thread's log, as the watch delivers it. */
export interface ThreadLogEvent {
  readonly sequence?: number;
  /** The prompt the event was written under. */
  readonly promptId?: string;
  readonly type: string;
  readonly event: unknown;
  readonly createdAt?: string;
}

/** One item of `watchThread`: the replay first, then the live events. */
export type ThreadWatchItem =
  | { readonly kind: 'snapshot'; readonly events: readonly ThreadLogEvent[] }
  | { readonly kind: 'event'; readonly event: ThreadLogEvent }
  | { readonly kind: 'updated' | 'deleted' };

/**
 * `runtime.threads/v1`, only the stream the canvas window reads its preview's
 * durable state from (spec: "De onde vêm os dados"). Optional: a window
 * without it reads the registry and stays at that reading.
 */
export interface ThreadsWatch {
  watchThread(
    input: { readonly threadId: string; readonly afterSequence: number },
    listener: StreamListener<ThreadWatchItem>,
    call?: CallArg,
  ): Disposable;
}

export const RuntimeThreadsV1 = ref<ThreadsWatch>('runtime.threads/v1');

/* Names the client and desktop parts share --------------------------------- */

/** The canvas element tag of the canvas route. */
export const PAPERCRAFT_CANVAS_TAG = 'papercraft-canvas';

/**
 * The Project and the Thread a preview belongs to: what every host call of the
 * node and the window carries as its scope (the host's lease needs the
 * `projectId`), and what the composer stack is keyed by.
 */
export interface PreviewScope {
  readonly projectId: string;
  readonly threadId?: string;
}

/** The call scope of a preview: its Project and, when known, its Thread. */
export const callScopeOf = (scope: PreviewScope): CallScope => ({
  projectId: scope.projectId,
  ...(scope.threadId === undefined ? {} : { threadId: scope.threadId }),
});

/** The window command that opens or focuses the canvas at a preview. */
export const OPEN_CANVAS_COMMAND = 'papercraft.open-canvas/v2';

/**
 * The path window the canvas opens as. The window is opened from a
 * conversation, and it carries that conversation in its path: the Project
 * scopes every host call, and the Thread is the composer stack its comments
 * join and the log it watches. The last segment (D26) is a papercraft
 * program's identity.
 */
export const CANVAS_ROUTE = '/papercraft/:projectId/:threadId/:identity';

/** The canvas window's path; `segment` is a program's identity. */
export const canvasPathOf = (input: {
  readonly projectId: string;
  readonly threadId: string;
  readonly segment: string;
}): string =>
  `/papercraft/${encodeURIComponent(input.projectId)}/${encodeURIComponent(
    input.threadId,
  )}/${encodeURIComponent(input.segment)}`;

/**
 * The canvas window's send: confirms the open note and sends the Thread's
 * stack through chat's `chat.send/v1`. In the conversation, the window's
 * `CmdOrCtrl+Enter` is chat's own send instead.
 */
export const SEND_COMMAND = 'papercraft.send/v1';

/* The command bar (papercraft/README.md, "A barra de comandos") ------------------ */

/** The armed tool of the canvas: `select` is the entry default. */
export type PreviewTool = 'select' | 'comment' | 'pan';

export const SELECT_COMMAND = 'papercraft.select/v1';
export const COMMENT_COMMAND = 'papercraft.comment/v1';
export const PAN_COMMAND = 'papercraft.pan/v1';
export const ISOLATE_COMMAND = 'papercraft.isolate/v1';
export const SHOW_ALL_COMMAND = 'papercraft.show-all/v1';
export const ZOOM_OUT_COMMAND = 'papercraft.zoom-out/v1';
export const ZOOM_RESET_COMMAND = 'papercraft.zoom-reset/v1';
export const ZOOM_IN_COMMAND = 'papercraft.zoom-in/v1';
export const ZOOM_FIT_COMMAND = 'papercraft.zoom-fit/v1';
export const SELECT_REVISION_COMMAND = 'papercraft.select-revision/v1';

/** Every command of the bar, with its shortcut for the tooltip's `<kbd>`. */
export const PAPERCRAFT_KEYBINDINGS = [
  { command: SELECT_COMMAND, key: 'V', label: 'Selecionar' },
  { command: COMMENT_COMMAND, key: 'C', label: 'Comentar' },
  { command: PAN_COMMAND, key: 'H', label: 'Mão' },
  { command: ISOLATE_COMMAND, key: 'I', label: 'Isolar' },
  { command: SHOW_ALL_COMMAND, key: 'Shift+I', label: 'Mostrar tudo' },
  { command: ZOOM_OUT_COMMAND, key: 'CmdOrCtrl+-', label: 'Menos zoom' },
  { command: ZOOM_RESET_COMMAND, key: 'CmdOrCtrl+0', label: 'Zoom 100%' },
  { command: ZOOM_IN_COMMAND, key: 'CmdOrCtrl+=', label: 'Mais zoom' },
  { command: ZOOM_FIT_COMMAND, key: 'Shift+1', label: 'Ajustar' },
  { command: SEND_COMMAND, key: 'CmdOrCtrl+Enter', label: 'Enviar' },
] as const;

/**
 * The composer stack item kind of a comment draft on a papercraft program
 * (D19), flushed by `programFlush`. Its `data` is a `PreviewItemData` whose
 * `target` has the kind `PROGRAM_TARGET_KIND` and whose `refs` is
 * `{ title: <identity> }`.
 */
export const PROGRAM_COMMENT_KIND = 'papercraft-program';

/**
 * What one composer stack item of the papercraft kind carries (`data`): the
 * comment's target, the pin it wears, the root it answers when it is a reply,
 * and the preview it was written on for the line to name. The flush reads the
 * target; chat's line reads `target` and `refs`.
 */
export interface PreviewItemData {
  readonly target: CommentTarget;
  /** The pin's number: `1`, `2`, … per artifact and revision. */
  readonly pin?: number;
  /** The root comment (or root draft) this reply answers. */
  readonly inReplyTo?: string;
  /** The preview the comment was written on: its title and source path. */
  readonly refs?: { readonly title?: string; readonly source?: string };
  /** Where the pin sits, in content coordinates, when it was placed. */
  readonly point?: { readonly x: number; readonly y: number };
}

/** What the toolbar's revision reading shows: which revisions exist. */
export interface RevisionReading {
  /** Which revision is on screen. */
  readonly current: number;
  /** How many revisions exist. */
  readonly total: number;
  /** Every revision, ascending; the dropdown's items. */
  readonly list: readonly number[];
}

/* papercraft.snapshot/v1 ---------------------------------------------------- */

// The desktopMain capture of a window's own pixels (isolamento.md, "O
// snapshot"): a window asks for a rectangle of its viewport and gets a PNG,
// which it keeps as the stand-in of a preview frame it unmounts. The main
// process captures the window's contents, so the opaque-origin preview frames
// inside the rectangle are in the picture. A window captures only itself: the
// window is the one the call left, never an input.

/** The longest side of a rectangle one capture takes, in CSS px. */
export const SNAPSHOT_MAX_SIDE = 4096;

/** A side of the rectangle: positive, finite, at most `SNAPSHOT_MAX_SIDE`. */
const snapshotSideSchema = z.number().positive().max(SNAPSHOT_MAX_SIDE);

/**
 * The rectangle to capture, in CSS px of the calling window's viewport (the
 * coordinates `getBoundingClientRect` answers in the window's own document).
 * It must lie inside the viewport; main refuses one that does not.
 */
export const snapshotRectSchema = z
  .object({
    x: z.number().nonnegative(),
    y: z.number().nonnegative(),
    width: snapshotSideSchema,
    height: snapshotSideSchema,
  })
  .strict();

export type SnapshotRect = z.output<typeof snapshotRectSchema>;

export const snapshotCaptureInputSchema = z
  .object({ rect: snapshotRectSchema })
  .strict();

export type SnapshotCaptureInput = z.input<typeof snapshotCaptureInputSchema>;

/**
 * One captured rectangle: the PNG bytes as base64 (what the bridge carries as
 * a string), its size in device pixels,
 * and the device pixels per CSS px it was taken at.
 */
export const snapshotSchema = z
  .object({
    png: z.string().min(1),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    scale: z.number().positive(),
  })
  .strict();

export type Snapshot = z.output<typeof snapshotSchema>;

/**
 * `papercraft.snapshot/v1` (desktopMain): captures a rectangle of the calling
 * window. It fails `invalid_input` for a rectangle that is not one or lies
 * outside the viewport, `unavailable` for a call that did not leave a window
 * or a capture main could not take, and `not_found` when the window closed.
 */
export interface PapercraftSnapshot {
  capture(input: SnapshotCaptureInput, call?: CallArg): Promise<Snapshot>;
}

export const papercraftSnapshotMethods = {
  capture: {
    input: snapshotCaptureInputSchema,
    output: snapshotSchema,
    expose: 'desktop',
  },
} as const satisfies MethodSpecs;

/** `papercraft.snapshot/v1`, as the `papercraft` bundle's desktop part provides it. */
export const PapercraftSnapshotV1 = ref<PapercraftSnapshot>(
  'papercraft.snapshot/v1',
);
