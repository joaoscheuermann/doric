// Public contracts of the `drawio` bundle (host side: read, save and export).
//
// - `drawio.diagrams/v1` (host): the reader of a diagram's stored XML. A
//   window reaches it over the bridge (`expose: 'desktop'`); 1.2.0 has `read`,
//   `save` and `export`.
// - `drawio.svg/v1` (desktopMain): the cache of the pages the client drew and
//   measured, keyed by revision, entry hash, page and theme.
// - The constants of the `diagram` kind, its block, its body tag, its one
//   entry and the ceilings every reader and writer of a diagram shares.
//
// The bundle consumes the contracts of other bundles — `artifacts/v1`,
// `artifact.kind/v1`, `comments/v1` (`list`, `add`, `resolve`),
// `runtime.lease/v1`, `runtime.workspace/v1` (`cwd`) and `runtime.threads/v1`
// (`watchThread`) — and keeps structural copies of the shapes
// it uses, as `papercraft` does: those bundles are built separately and this
// one must not import them at compile time. The IDs and shapes are theirs.

import {
  type CallArg,
  type CallScope,
  type Disposable,
  type DrawioDescription,
  drawioDescriptionSchema,
  type MethodSpecs,
  ref,
  type StreamListener,
} from 'bundle/contracts';
import { z } from 'zod';

export * from './chat.js';

/* Constants ---------------------------------------------------------------- */

/** The artifact kind this bundle owns. */
export const DIAGRAM_KIND = 'diagram';
/** The block type the registry's frame hands the body. */
export const DIAGRAM_BLOCK_TYPE = 'drawio.diagram/v1';
/** The custom element the frame creates for the body. */
export const DIAGRAM_BODY_TAG = 'drawio-diagram';
/** The one entry of every revision: the normalized `mxfile`. */
export const DIAGRAM_ENTRY = 'diagram.drawio';
/** The tool name the model calls; fixed by the design. */
export const DRAWIO_DIAGRAM_TOOL = 'drawio_diagram';
/** The global model-visible position: between papercraft_preview (1700) and comment_reply (1800). */
export const DRAWIO_DIAGRAM_ORDER = 1750;
/** The comment-stack kind of a diagram comment. */
export const DRAWIO_COMMENT_KIND = 'drawio-diagram';
/** Where the skill tells the agent to write its drafts. */
export const DRAFTS_DIR = '.doric/artifacts/drafts';
/** The ceiling of a diagram's XML, in UTF-8 bytes; the only source of this value. */
export const MAX_DIAGRAM_BYTES = 2_097_152;
/** The ceiling of an SVG, in the cache and in the export. */
export const MAX_SVG_BYTES = 8_388_608;
/** The ceiling of pages (`<diagram>` elements) of one diagram. */
export const MAX_PAGES = 50;
/** The ceiling of cells summed over every page. */
export const MAX_CELLS = 5_000;
/** The change note of a revision the user saved from the editor; reserved. */
export const USER_CHANGE_NOTE = 'Editado pelo usuário';
/** Deadline of one request to the renderer or the measure frame. */
export const RENDER_TIMEOUT_MS = 5_000;
/** Deadline of the modal's editor until `load`, and of each request to it. */
export const EDITOR_LOAD_TIMEOUT_MS = 10_000;
/** Interval of the check that the modal's editor still answers. */
export const EDITOR_HEARTBEAT_MS = 10_000;

/* Pages -------------------------------------------------------------------- */

/** One page: the `id` and `name` of its `<diagram>` and its number of cells. */
export const pageSummarySchema = z
  .object({ id: z.string(), name: z.string(), cells: z.number().int() })
  .strict();

export type PageSummary = z.output<typeof pageSummarySchema>;

/* Artifacts (structural copy of `artifacts/v1`) ---------------------------- */

/**
 * The identity grammar of an artifact: lowercase segments separated by single
 * dashes (the registry's own rule, also a directory name of the work copy).
 */
export const artifactIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The artifact id schema every wire shape that names an artifact uses. */
export const artifactIdSchema = z
  .string()
  .regex(artifactIdPattern, { message: 'Not an artifact id.' });

/** One entry of a revision: its artifact-relative path and the sha256 of its bytes. */
export interface ArtifactEntry {
  readonly path: string;
  readonly sha256: string;
}

/**
 * One entry as `read` serves it: `base64` is present only while the work copy
 * still holds bytes that hash to `sha256`.
 */
export interface ArtifactReadEntry extends ArtifactEntry {
  readonly base64?: string;
}

/** The bytes of one entry, base64, as `create`/`revise` hand them once. */
export interface ArtifactFile {
  readonly path: string;
  readonly base64: string;
}

/** One artifact on one of its revisions, as far as this bundle reads it. */
export interface ArtifactRecord {
  readonly artifactId: string;
  readonly kind: string;
  readonly title: string;
  /** The revision this record describes, 1-based. */
  readonly revision: number;
  /** How many revisions the artifact has. */
  readonly revisions: number;
  /** The entries of this revision: paths and hashes, never bytes. */
  readonly entries: readonly ArtifactEntry[];
  /** Workspace path of this revision's payload. */
  readonly path?: string;
  /** The note given on `create`. */
  readonly notes?: string;
  /** The note this revision was published with, when it was a `revise`. */
  readonly changeNote?: string;
  /** The review state of this revision. */
  readonly state: 'open' | 'approved';
  /** ISO-8601, when the artifact was created. */
  readonly createdAt: string;
}

/** The record of one revision plus the bytes of its entries. */
export interface ArtifactRevisionRead extends Omit<ArtifactRecord, 'entries'> {
  readonly entries: readonly ArtifactReadEntry[];
}

/**
 * `artifacts/v1` (host), as far as this bundle calls it. No method acquires a
 * lease; a Project without one fails the call with its lease state.
 */
export interface Artifacts {
  /**
   * Writes revision 1 with the given entries, verifying each file's hash
   * against the entry of the same path before writing it.
   */
  create(
    input: {
      readonly kind: string;
      readonly title: string;
      readonly path?: string;
      readonly notes?: string;
      readonly entries: readonly ArtifactEntry[];
      readonly files: readonly ArtifactFile[];
    },
    call?: CallArg,
  ): Promise<ArtifactRecord>;
  /** Adds the next revision; absent fields carry over, earlier revisions stay untouched. */
  revise(
    input: {
      readonly artifactId: string;
      readonly path?: string;
      readonly changeNote?: string;
      readonly entries: readonly ArtifactEntry[];
      readonly files: readonly ArtifactFile[];
    },
    call?: CallArg,
  ): Promise<ArtifactRecord>;
  /**
   * One revision (absent: the newest) with the bytes of its entries, or
   * undefined when the artifact or the revision does not exist.
   */
  read(
    input: { readonly artifactId: string; readonly revision?: number },
    call?: CallArg,
  ): Promise<ArtifactRevisionRead | undefined>;
  /** Every revision, oldest first, without bytes; empty when the artifact does not exist. */
  revisions(
    input: { readonly artifactId: string },
    call?: CallArg,
  ): Promise<readonly ArtifactRecord[]>;
}

export const ArtifactsV1 = ref<Artifacts>('artifacts/v1');

/* Artifact kinds (structural copy of `artifact.kind/v1`) ------------------- */

export interface ArtifactKinds {
  /**
   * Registers a kind; the release unregisters it. A duplicate id fails with
   * `registration_conflict`. A kind that declares `bodyTag` renders its body
   * inside the registry's frame, which creates `bodyTag` with its block
   * (`type` = `blockType`).
   */
  register(
    input: {
      readonly id: string;
      readonly title?: string;
      readonly blockType?: string;
      readonly bodyTag?: string;
      /** Who draws the header: the registry's frame (default) or the body. */
      readonly header?: 'frame' | 'body';
    },
    call?: CallArg,
  ): Promise<Disposable> | Disposable;
}

export const ArtifactKindV1 = ref<ArtifactKinds>('artifact.kind/v1');

/* Comments (structural copy of `comments/v1`) ------------------------------ */

/** The fields every anchor form may carry; each form then requires its own. */
const anchorFields = {
  path: z.string().optional(),
  line: z.number().int().positive().optional(),
  selector: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  label: z.string().optional(),
  text: z.string().optional(),
  /** The `::before` / `::after` the comment is on; absent means the element itself. */
  pseudo: z.enum(['::before', '::after']).optional(),
};

/**
 * Where in the target a comment sits, validated per form as `comments/v1`
 * validates it: `source` names a `path`, `selector` a `selector`, `point`
 * both `x` and `y`, `range` its `text`.
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

/** The target kind an artifact comment carries. */
export const ARTIFACT_TARGET_KIND = 'artifact';

/** The identity of a target, as `comments/v1.list` filters by it. */
export interface CommentTargetKey {
  readonly kind: string;
  readonly id: string;
  readonly revision?: number;
}

/** `comments/v1`, as far as this bundle calls it: `add`, `list` and `resolve`. */
export interface Comments {
  /**
   * Writes one comment and answers it as stored. A write that repeats a
   * `commentId` already written is idempotent.
   */
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
 * `runtime.threads/v1`, only the stream the diagram node reads its durable
 * comment state from. Optional (`manifest.json` `optional`): a node without
 * it reads `comments/v1.list` and stays at that reading.
 */
export interface ThreadsWatch {
  /**
   * Delivers one `snapshot` of the events after `afterSequence`, then each
   * new event as it is written, until the returned handle is disposed.
   */
  watchThread(
    input: { readonly threadId: string; readonly afterSequence: number },
    listener: StreamListener<ThreadWatchItem>,
    call?: CallArg,
  ): Disposable;
}

export const RuntimeThreadsV1 = ref<ThreadsWatch>('runtime.threads/v1');

/* The Project and Thread scope of a diagram --------------------------------- */

/**
 * The Project and the Thread a diagram node belongs to: what every host call
 * of the node carries as its scope (the host's lease needs the `projectId`),
 * and what the composer stack is keyed by.
 */
export interface DiagramScope {
  readonly projectId: string;
  readonly threadId?: string;
}

/**
 * The call scope of a diagram: `{ projectId }`, plus `threadId` exactly when
 * the scope names one. Pure; never throws.
 */
export const callScopeOf = (scope: DiagramScope): CallScope => ({
  projectId: scope.projectId,
  ...(scope.threadId === undefined ? {} : { threadId: scope.threadId }),
});

/* drawio.svg/v1 (desktopMain) ----------------------------------------------- */

/** The two themes a page is drawn in: the app's light and dark. */
export type DiagramTheme = 'light' | 'dark';

/** One revision's `diagram.drawio`, as the cache keys it: the pages of these bytes. */
export interface DiagramSvgRevision {
  /** Follows `artifactIdSchema`. */
  readonly artifactId: string;
  /** 1-based. */
  readonly revision: number;
  /** The SHA-256 of the revision's `diagram.drawio` entry: 64 lowercase hex digits. */
  readonly sha256: string;
}

/** Which drawing `drawio.svg/v1` keys: one page of one revision, in one theme. */
export interface DiagramSvgKey extends DiagramSvgRevision {
  /** The page's `<diagram id>`, 1 to 128 characters; any character, since the cache encodes it. */
  readonly pageId: string;
  readonly theme: DiagramTheme;
}

/**
 * What `get` looks up: a key whose `pageId` may be left out, meaning "the
 * revision's first page" as a `put` with `first` recorded it.
 */
export interface DiagramSvgLookup extends DiagramSvgRevision {
  readonly pageId?: string;
  readonly theme: DiagramTheme;
}

/** One cell's box, in content px relative to the page's `<svg>`; every number finite and ≥ 0. */
export interface DiagramLayoutCell {
  /** The element's `data-cell-id`, non-empty. */
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The layout of one page, in content px (the SVG at scale 1); every number finite and ≥ 0. */
export interface DiagramLayout {
  readonly width: number;
  readonly height: number;
  /** One box per element with `data-cell-id`, in document order; at most MAX_CELLS. */
  readonly cells: readonly DiagramLayoutCell[];
}

/** What the cache holds for one key: the SVG text and its measured layout. */
export interface DiagramSvgEntry {
  readonly svg: string;
  readonly layout: DiagramLayout;
}

/** What `get` answers: the entry and the page it belongs to (the one asked for, or the one the pointer named). */
export interface DiagramSvgPage extends DiagramSvgEntry {
  readonly pageId: string;
}

/** What `put` stores: the key, the entry and, for the revision's first page, `first`. */
export interface DiagramSvgPut extends DiagramSvgKey, DiagramSvgEntry {
  /**
   * The page is the revision's first `<diagram>`: the put also records it as
   * the revision's first page, for every theme.
   */
  readonly first?: true;
}

/**
 * `drawio.svg/v1` (desktopMain, `expose: 'desktop'`): the cache of drawn and
 * measured pages, and of each revision's first page id. It neither draws nor
 * measures; the client does both. No method needs a lease. Entries are never
 * evicted in v1.
 */
export interface DrawioSvg {
  /**
   * `doric.drawio/v1.describe`, passed through unchanged. Never rejects for
   * an unavailable origin: it resolves `{ available: false, reason }`.
   */
  status(call?: CallArg): Promise<DrawioDescription>;
  /**
   * The SVG and layout stored for the lookup, with their `pageId`. With a
   * `pageId`, that page's entry. Without one, the page the revision's
   * first-page pointer names (one pointer per artifact, revision and
   * `sha256`, whatever the theme), then that page's entry in `theme`. Null
   * when the pointer or either entry file is missing, unreadable or
   * off-schema. An off-schema lookup fails with `invalid_input`. Reads only;
   * never writes.
   */
  get(input: DiagramSvgLookup, call?: CallArg): Promise<DiagramSvgPage | null>;
  /**
   * Stores what the client drew and measured under the key, replacing any
   * earlier entry; with `first`, then records `pageId` as the revision's
   * first page, replacing any earlier pointer. A reader never sees a partial
   * file: each file is written whole or not at all, layout, then SVG, then
   * the pointer — so a pointer read always names a page whose entry was
   * stored in at least one theme. Fails with `invalid_input`, and writes
   * nothing, for a bad key; for an SVG that is not `<svg…` (after whitespace
   * and an optional XML declaration) or is over MAX_SVG_BYTES in UTF-8; for a
   * layout with a negative or non-finite number, an empty cell id, or more
   * than MAX_CELLS boxes; for a `first` other than `true`.
   */
  put(input: DiagramSvgPut, call?: CallArg): Promise<void>;
}

/**
 * Whether `text` is an SVG document: after optional whitespace and an
 * optional `<?xml …?>` declaration (and whitespace after it), it starts with
 * `<svg` followed by whitespace, `>` or `/`. Pure; never throws.
 */
export function isSvgText(text: string): boolean {
  return /^\s*(?:<\?xml[\s\S]*?\?>\s*)?<svg[\s>/]/.test(text);
}

/** The UTF-8 byte length of `text` (as `TextEncoder` encodes it). Pure; never throws. */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** A finite number ≥ 0: what every coordinate and size of a layout is. */
const layoutNumberSchema = z.number().finite().nonnegative();

/** A page id as the cache takes it: 1 to 128 characters, any character. */
export const diagramPageIdSchema = z.string().min(1).max(128);

/** The closed wire shape of `DiagramSvgKey`. */
export const diagramSvgKeySchema = z
  .object({
    artifactId: artifactIdSchema,
    revision: z.number().int().positive(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    pageId: diagramPageIdSchema,
    theme: z.enum(['light', 'dark']),
  })
  .strict();

/** The closed wire shape of `DiagramSvgLookup`: the key with `pageId` optional. */
export const diagramSvgLookupSchema = diagramSvgKeySchema
  .extend({ pageId: diagramPageIdSchema.optional() })
  .strict();

/** The closed shape of the first-page pointer file: `{ "pageId": … }`. */
export const diagramFirstPageSchema = z
  .object({ pageId: diagramPageIdSchema })
  .strict();

/** The closed wire shape of `DiagramLayoutCell`. */
export const diagramLayoutCellSchema = z
  .object({
    id: z.string().min(1),
    x: layoutNumberSchema,
    y: layoutNumberSchema,
    width: layoutNumberSchema,
    height: layoutNumberSchema,
  })
  .strict();

/** The closed wire shape of `DiagramLayout`: at most MAX_CELLS boxes. */
export const diagramLayoutSchema = z
  .object({
    width: layoutNumberSchema,
    height: layoutNumberSchema,
    cells: z.array(diagramLayoutCellSchema).max(MAX_CELLS),
  })
  .strict();

/** The closed wire shape of `DiagramSvgEntry` (the SVG is not re-checked). */
export const diagramSvgEntrySchema = z
  .object({ svg: z.string(), layout: diagramLayoutSchema })
  .strict();

/** The closed wire shape of `DiagramSvgPage`, as `get` answers it. */
export const diagramSvgPageSchema = diagramSvgEntrySchema
  .extend({ pageId: diagramPageIdSchema })
  .strict();

/**
 * The closed input of `put`: the key plus an SVG that passes `isSvgText`
 * within MAX_SVG_BYTES, its layout, and an optional `first: true`.
 */
export const diagramSvgPutSchema = diagramSvgKeySchema
  .extend({
    svg: z
      .string()
      .refine((svg) => isSvgText(svg) && utf8Bytes(svg) <= MAX_SVG_BYTES, {
        message: `Not an SVG document of at most ${MAX_SVG_BYTES} bytes.`,
      }),
    layout: diagramLayoutSchema,
    first: z.literal(true).optional(),
  })
  .strict();

export const drawioSvgMethods = {
  status: {
    input: z.tuple([]),
    output: drawioDescriptionSchema,
    expose: 'desktop',
  },
  get: {
    input: diagramSvgLookupSchema,
    output: diagramSvgPageSchema.nullable(),
    expose: 'desktop',
  },
  put: {
    input: diagramSvgPutSchema,
    output: z.void(),
    expose: 'desktop',
  },
} as const satisfies MethodSpecs;

/** `drawio.svg/v1`, as the `drawio` bundle's desktopMain part provides it. */
export const DrawioSvgV1 = ref<DrawioSvg>('drawio.svg/v1');

/* Comments of the drawio-diagram kind --------------------------------------- */

/**
 * A comment on one cell, as `CommentTarget.anchor` carries it (a `selector`
 * anchor; the extra keys ride on the loose schema).
 */
export type DiagramCellAnchor = {
  readonly form: 'selector';
  /** `page/<pageId>/cell/<cellId>`. */
  readonly selector: string;
  /** The cell's text, HTML reduced to text, whitespace collapsed, at most 200 characters; '' without text. */
  readonly label: string;
  /** Centre of the cell's box in the revision's SVG, content px. */
  readonly x: number;
  readonly y: number;
  readonly cellKind: 'vertex' | 'edge';
  /** Position among the page's cells of the same `cellKind` and `label`, in document order, from 0. */
  readonly index: number;
};

/** A comment on a free point of a page (also `form: 'selector'`, so the envelope shows the page). */
export type DiagramPointAnchor = {
  readonly form: 'selector';
  /** `page/<pageId>/point/<Math.round(x)>,<Math.round(y)>`. */
  readonly selector: string;
  /** The label of the cell whose centre is nearest; '' without cells. */
  readonly label: string;
  /** The point, content px. */
  readonly x: number;
  readonly y: number;
};

/** The two anchors a diagram comment carries; `cellKind` tells them apart. */
export type DiagramAnchor = DiagramCellAnchor | DiagramPointAnchor;

/**
 * The `data` of one composer item of kind DRAWIO_COMMENT_KIND: the comment's
 * target `{ kind: 'artifact', id, revision, anchor }`, its pin, the root a
 * reply answers, what chat's line names (`refs.source` is DIAGRAM_ENTRY) and
 * the clicked content point. The flush reads `target` and `inReplyTo`; chat's
 * line reads `target` and `refs`.
 */
export interface DiagramItemData {
  readonly target: CommentTarget;
  /** The pin's number: `1`, `2`, … per artifact and revision. */
  readonly pin?: number;
  /** The root comment (or root draft) this reply answers. */
  readonly inReplyTo?: string;
  /** The diagram the comment was written on: its title and entry. */
  readonly refs?: { readonly title?: string; readonly source?: string };
  /** Where the draft's pin sits, in content px, until its anchor resolves. */
  readonly point?: { readonly x: number; readonly y: number };
}

/** `value` as a record of its own keys, or undefined when it is not an object. */
const recordOf = (
  value: unknown,
): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

/**
 * The target a stack item's `data` names: its `target` when that is an object
 * with a non-empty string `id` and an object `anchor` (`kind` defaults to
 * ARTIFACT_TARGET_KIND, `revision` kept only when a number); otherwise
 * undefined. Total over `unknown`, never throws, DOM-free: the desktopMain
 * flush calls it.
 */
export const diagramItemTargetOf = (
  data: unknown,
): CommentTarget | undefined => {
  const target = recordOf(recordOf(data)?.target);

  if (
    target === undefined ||
    typeof target.id !== 'string' ||
    target.id === '' ||
    recordOf(target.anchor) === undefined
  ) {
    return undefined;
  }

  return {
    kind: typeof target.kind === 'string' ? target.kind : ARTIFACT_TARGET_KIND,
    id: target.id,
    ...(typeof target.revision === 'number'
      ? { revision: target.revision }
      : {}),
    anchor: target.anchor as CommentAnchor,
  };
};

/* Lease and workspace (structural copies of `runtime.lease/v1`, `runtime.workspace/v1`) */

/**
 * What a lease-dependent operation answers: the task's value, or why the
 * Project's lease could not run it.
 */
export type LeaseOutcome<T> =
  | { readonly status: 'ready'; readonly value: T }
  | {
      readonly status: 'pending' | 'unavailable' | 'expired' | 'missing';
    };

/**
 * The leased sandbox, as far as this bundle uses it
 * (`packages/sandbox/src/lib/sandbox.ts:126-148`). Paths are absolute inside
 * the sandbox.
 */
export interface LeasedSandbox {
  /** The Project's workspace root, absolute (`/workspace`). */
  readonly root: string;
  /** The file's exact bytes; rejects when it is missing, a directory or unreadable. */
  getFile(path: string): Promise<Uint8Array>;
  /** Writes `content` as UTF-8, creating the missing parent folders. */
  writeFile(path: string, content: string): Promise<void>;
  /**
   * Runs one command without a shell. This bundle runs `test -f`, `-e`, `-d`
   * or `-h <path>`, and `rm -f -- <path>`. The tool reads exit code 0 as yes
   * and any other code, or `null`, as no; `export` reads 0 as yes, 1 as no,
   * and any other code, or `null`, as a failed check.
   */
  exec(input: {
    readonly cmd: readonly string[];
  }): Promise<{ readonly exitCode: number | null }>;
}

export interface RuntimeLease {
  /**
   * Runs `task` on the Project's leased sandbox, taking no lock. Without a
   * lease the task does not run and the outcome names the lease state; an
   * error the task throws passes through unchanged.
   */
  withLease<T>(
    task: (sandbox: LeasedSandbox) => Promise<T>,
    call?: CallArg,
  ): Promise<LeaseOutcome<T>>;
}

export const RuntimeLeaseV1 = ref<RuntimeLease>('runtime.lease/v1');

export interface RuntimeWorkspace {
  /** The Thread's current working directory, absolute inside the sandbox. */
  cwd(call?: CallArg): Promise<string>;
}

export const RuntimeWorkspaceV1 = ref<RuntimeWorkspace>('runtime.workspace/v1');

/* drawio.diagrams/v1 -------------------------------------------------------- */

/** What `read` answers; `status` tells the three cases apart. */
export type DiagramRead =
  | {
      readonly status: 'ok';
      /** The revision's normalized XML: the stored bytes decoded as UTF-8. */
      readonly xml: string;
      readonly revision: number;
      /** How many revisions the artifact has now. */
      readonly revisions: number;
    }
  /** The artifact, the revision, its `diagram.drawio` entry or its bytes do not exist. */
  | { readonly status: 'missing' }
  /** No lease: the state `withLease` answered. */
  | {
      readonly status: 'unleased';
      readonly lease: 'pending' | 'unavailable' | 'expired' | 'missing';
    };

export interface DrawioDiagrams {
  /**
   * 1.0.0 (phase 2): the XML of one revision of a diagram. A missing
   * artifact, revision, entry or bytes answers `missing` and a missing lease
   * answers `unleased`, never an error; it writes nothing.
   */
  read(
    input: { readonly artifactId: string; readonly revision: number },
    call?: CallArg,
  ): Promise<DiagramRead>;
  /**
   * 1.1.0 (phase 3): writes the editor's XML as the next revision, with the note
   * USER_CHANGE_NOTE, through `artifacts/v1.revise` (no `path`: it carries over),
   * even when a revision newer than the one opened exists (D15). When the
   * normalized XML equals the latest revision's, writes nothing and answers the
   * latest. `invalid_input` for an XML `normalizeDiagram` refuses (checked before
   * the lease) and for an artifact that is not a diagram; `not_found` for no
   * artifact (O1); `unavailable` with `details.lease` without a lease.
   */
  save(input: DiagramSaveInput, call?: CallArg): Promise<DiagramSaved>;
  /**
   * 1.2.0 (phase 4): writes `<path>.drawio` (the revision's stored, normalized
   * XML, every page) and `<path>.drawio.svg` (`svg`, an `xmlsvg` export of page
   * 1), in that order, under the Project root. Before writing it checks, with
   * `test` through `exec` (never `getFile`), the path's folders and both files:
   * an entry export never replaces answers `blocked`, also with `overwrite`;
   * otherwise a regular file at either path with `overwrite` false answers
   * `exists`. In both cases nothing is written. A failed second write removes
   * the first (`rm -f`). Rejects with `invalid_input` (path or svg refused,
   * before the lease), `not_found` (no such revision), `unavailable` with
   * `details.lease` (no lease) or `internal` (a check or a write failed;
   * nothing of this call is left but empty folders).
   */
  export(input: DiagramExportInput, call?: CallArg): Promise<ExportResult>;
}

/** What `save` answers: the revision that now holds the editor's XML. */
export interface DiagramSaved {
  /** The revision just written; or the latest, when the normalized XML equals it. */
  readonly revision: number;
  /** How many revisions the artifact has now. */
  readonly revisions: number;
  /** Lowercase hex SHA-256 of that revision's DIAGRAM_ENTRY (the normalized XML): the block's `sha256`. */
  readonly sha256: string;
}

/** The input of `save`: the artifact and the editor's XML (`getXml()`), nothing else. */
export type DiagramSaveInput = {
  readonly artifactId: string;
  readonly xml: string;
};

/** The closed wire shape of `DiagramSaveInput`: unknown keys are refused. */
export const diagramSaveInputSchema: z.ZodType<DiagramSaveInput> = z
  .object({ artifactId: artifactIdSchema, xml: z.string() })
  .strict();

/** The closed wire shape of `DiagramSaved`. */
export const diagramSavedSchema: z.ZodType<DiagramSaved, DiagramSaved> = z
  .object({
    revision: z.number().int().positive(),
    revisions: z.number().int().positive(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

/** The input of `read`: an artifact id and a 1-based revision; nothing else. */
export const diagramReadInputSchema = z
  .object({
    artifactId: artifactIdSchema,
    revision: z.number().int().positive(),
  })
  .strict();

export type DiagramReadInput = z.output<typeof diagramReadInputSchema>;

/** The closed wire shape of `DiagramRead`. */
export const diagramReadSchema: z.ZodType<DiagramRead, DiagramRead> =
  z.discriminatedUnion('status', [
    z
      .object({
        status: z.literal('ok'),
        xml: z.string(),
        revision: z.number().int().positive(),
        revisions: z.number().int().positive(),
      })
      .strict(),
    z.object({ status: z.literal('missing') }).strict(),
    z
      .object({
        status: z.literal('unleased'),
        lease: z.enum(['pending', 'unavailable', 'expired', 'missing']),
      })
      .strict(),
  ]);

/** The input of `export`. `path` is Project-relative, without extension. */
export interface DiagramExportInput {
  readonly artifactId: string;
  /** The revision on screen (1-based). */
  readonly revision: number;
  /**
   * Relative, no leading `/`, no empty, `.` or `..` segment, not in `.doric/`,
   * not ending in `.drawio` or `.drawio.svg`, at most 512 characters.
   */
  readonly path: string;
  /** An `xmlsvg` export: SVG text with a `content` attribute, at most MAX_SVG_BYTES. */
  readonly svg: string;
  readonly overwrite: boolean;
}

/** What `export` answers; paths are Project-relative, like `input.path`. */
export type ExportResult =
  /** Both written; `files` is `[<path>.drawio, <path>.drawio.svg]`. */
  | { readonly status: 'written'; readonly files: readonly string[] }
  /** `overwrite` false; `files`: those that are regular files, in the same order. */
  | { readonly status: 'exists'; readonly files: readonly string[] }
  /**
   * An entry export never replaces: `path` is one of the two files
   * (`directory`: a folder; `special`: a symbolic link, a fifo, a socket or a
   * device) or a folder prefix of the path that exists and is not a folder
   * (`not-a-folder`).
   */
  | {
      readonly status: 'blocked';
      readonly path: string;
      readonly reason: 'directory' | 'special' | 'not-a-folder';
    };

/** The closed wire shape of `DiagramExportInput`; the path and svg rules are checked by `export`. */
export const diagramExportInputSchema: z.ZodType<DiagramExportInput> = z
  .object({
    artifactId: artifactIdSchema,
    revision: z.number().int().positive(),
    path: z.string(),
    svg: z.string(),
    overwrite: z.boolean(),
  })
  .strict();

/** The closed wire shape of `ExportResult`. */
export const exportResultSchema: z.ZodType<ExportResult, ExportResult> =
  z.discriminatedUnion('status', [
    z
      .object({
        status: z.literal('written'),
        files: z.array(z.string()).min(1).max(2),
      })
      .strict(),
    z
      .object({
        status: z.literal('exists'),
        files: z.array(z.string()).min(1).max(2),
      })
      .strict(),
    z
      .object({
        status: z.literal('blocked'),
        path: z.string(),
        reason: z.enum(['directory', 'special', 'not-a-folder']),
      })
      .strict(),
  ]);

export const drawioDiagramsMethods = {
  read: {
    input: diagramReadInputSchema,
    output: diagramReadSchema,
    expose: 'desktop',
  },
  save: {
    input: diagramSaveInputSchema,
    output: diagramSavedSchema,
    expose: 'desktop',
  },
  export: {
    input: diagramExportInputSchema,
    output: exportResultSchema,
    expose: 'desktop',
  },
} as const satisfies MethodSpecs;

/** `drawio.diagrams/v1`, as the `drawio` bundle provides it. */
export const DrawioDiagramsV1 = ref<DrawioDiagrams>('drawio.diagrams/v1');
