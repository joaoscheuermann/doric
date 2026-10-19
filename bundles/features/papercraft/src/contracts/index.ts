// Public contracts of the `papercraft` bundle (stage: previews).
//
// - `papercraft.previews/v1` (host): the preview builder and reader. `build`
//   derives the self-contained markup of a Project source file (path A); `read`
//   resolves a stored revision back to `{ files, markup }` for the node and the
//   canvas. A window reaches both over the bridge (`expose: 'desktop'`).
//
// The bundle consumes the contracts of other bundles — `artifacts/v1`,
// `artifact.kind/v1` and `comments/v1` — and keeps structural copies of the
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

export * from './chat.js';

/* papercraft.previews/v1 ---------------------------------------------------- */

/** Where a preview's markup comes from; path A supports `html` and `component`. */
export const previewSourceSchema = z.enum(['html', 'component']);

export type PreviewSource = z.output<typeof previewSourceSchema>;

/** One built file of a revision: its artifact-relative path and content hash. */
export const previewFileSchema = z
  .object({
    path: z.string().min(1),
    sha256: z.string().min(1),
  })
  .strict();

export type PreviewFile = z.output<typeof previewFileSchema>;

export const previewBuildInputSchema = z
  .object({
    /** The Project-relative source path the preview is built from. */
    path: z.string().min(1),
    /** The component entry, when `source` is `component`. */
    entry: z.string().min(1).optional(),
    source: previewSourceSchema,
    /**
     * The artifact the built payload belongs to. Extra fields are allowed; the
     * builder uses the pair to key the stored revision when it is given.
     */
    artifactId: z.string().min(1).optional(),
    revision: z.number().int().positive().optional(),
  })
  .strict();

export type PreviewBuildInput = z.input<typeof previewBuildInputSchema>;

export const previewBuildSchema = z
  .object({ files: z.array(previewFileSchema) })
  .strict();

export type PreviewBuild = z.output<typeof previewBuildSchema>;

export const previewReadInputSchema = z
  .object({
    artifactId: z.string().min(1),
    revision: z.number().int().positive(),
  })
  .strict();

export type PreviewReadInput = z.input<typeof previewReadInputSchema>;

/** The resolved preview state the node and the canvas render. */
export const previewStateSchema = z
  .object({
    artifactId: z.string().min(1),
    revision: z.number().int().positive(),
    kind: z.literal('preview'),
    files: z.array(previewFileSchema),
    markup: z.string(),
    /**
     * Set when the markup was re-derived from the current source because the
     * revision has no built files stored to serve — the reading the revision
     * froze is absent, and this is the live derivation of it.
     */
    derived: z.boolean().optional(),
  })
  .strict();

export type PreviewState = z.output<typeof previewStateSchema>;

export const previewStateOrUndefinedSchema = z.union([
  previewStateSchema,
  z.undefined(),
]);

export interface PapercraftPreviews {
  /** Derives the built files of a Project source, writing nothing. */
  build(input: PreviewBuildInput, call?: CallArg): Promise<PreviewBuild>;
  /** The built markup of a revision, or undefined when it does not exist. */
  read(
    input: PreviewReadInput,
    call?: CallArg,
  ): Promise<PreviewState | undefined>;
}

export const papercraftPreviewsMethods = {
  build: {
    input: previewBuildInputSchema,
    output: previewBuildSchema,
    expose: 'desktop',
  },
  read: {
    input: previewReadInputSchema,
    output: previewStateOrUndefinedSchema,
    expose: 'desktop',
  },
} as const satisfies MethodSpecs;

/** `papercraft.previews/v1`, as the `papercraft` bundle provides it. */
export const PapercraftPreviewsV1 = ref<PapercraftPreviews>(
  'papercraft.previews/v1',
);

/* The artifact kind -------------------------------------------------------- */

/** The one kind this bundle owns. */
export const PREVIEW_KIND = 'preview';

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
  content(
    input: { readonly path: string },
    call?: CallArg,
  ): Promise<LeaseOutcome<FilesContentRead>>;
}

export const FilesV1 = ref<Files>('files/v1');

/* Artifacts (structural copy of `artifacts/v1`) ---------------------------- */

/** An anchor into the Project's code, as the artifacts registry carries it. */
export const artifactTargetSchema = z
  .object({
    path: z.string().min(1),
    line: z.number().int().positive().optional(),
    /** The first and last line the anchor covers. */
    lines: z
      .tuple([z.number().int().positive(), z.number().int().positive()])
      .optional(),
    snippet: z.string().optional(),
  })
  .loose();

export type ArtifactTarget = z.output<typeof artifactTargetSchema>;

export const artifactRecordSchema = z
  .object({
    artifactId: z.string().min(1),
    kind: z.string().min(1),
    title: z.string(),
    revision: z.number().int().positive(),
    revisions: z.number().int().positive(),
    targets: z.array(artifactTargetSchema),
    source: previewSourceSchema.optional(),
    path: z.string().optional(),
    entry: z.string().optional(),
    /** The review state of this revision (per revision, not per artifact). */
    state: z.enum(['open', 'approved']),
    createdAt: z.string(),
    createdBy: z.string().optional(),
  })
  .loose();

export type ArtifactRecord = z.output<typeof artifactRecordSchema>;

/**
 * One entry of a revision the registry read back: the identity it recorded and
 * the bytes it serves while the work copy still holds them, as the `artifacts`
 * bundle's own `ArtifactRevisionRead` carries them.
 */
export const artifactReadEntrySchema = z
  .object({
    path: z.string().min(1),
    sha256: z.string().min(1),
    base64: z.string().optional(),
  })
  .strict();

export type ArtifactReadEntry = z.output<typeof artifactReadEntrySchema>;

/** The record of one revision plus the entries it named. */
export interface ArtifactRevisionRead extends ArtifactRecord {
  readonly entries: readonly ArtifactReadEntry[];
}

/** The bytes of one entry, base64, as `create`/`revise` hand them once. */
export interface ArtifactFile {
  readonly path: string;
  readonly base64: string;
}

/**
 * The revision a caller built itself: its entries (identity) and their bytes,
 * which the registry verifies against the entries before writing them into the
 * work copy. A caller that passes these needs no kind materialization.
 */
export interface ArtifactBuiltRevision {
  readonly entries?: readonly PreviewFile[];
  readonly files?: readonly ArtifactFile[];
  /** The kind's payload, for the registry to materialize instead. */
  readonly payload?: unknown;
}

export interface Artifacts {
  create(
    input: {
      readonly artifactId?: string;
      readonly kind: string;
      readonly title: string;
      readonly targets?: readonly ArtifactTarget[];
      readonly source?: PreviewSource;
      readonly path?: string;
      readonly entry?: string;
      readonly notes?: string;
    } & ArtifactBuiltRevision,
    call?: CallArg,
  ): Promise<ArtifactRecord>;
  /** Adds the next revision; absent fields carry over from the previous one. */
  revise(
    input: {
      readonly artifactId: string;
      readonly changeNote?: string;
      readonly targets?: readonly ArtifactTarget[];
      readonly source?: PreviewSource;
      readonly path?: string;
      readonly entry?: string;
    } & ArtifactBuiltRevision,
    call?: CallArg,
  ): Promise<ArtifactRecord>;
  read(
    input: { readonly artifactId: string; readonly revision?: number },
    call?: CallArg,
  ): Promise<ArtifactRevisionRead | undefined>;
  /** Every revision's record, oldest first, without bytes. */
  revisions(
    input: { readonly artifactId: string },
    call?: CallArg,
  ): Promise<readonly ArtifactRecord[]>;
  /**
   * Under `request`, records the approval of one revision and makes that
   * revision `approved`; under `proceed` it writes nothing.
   */
  approve(
    input: { readonly artifactId: string; readonly revision: number },
    call?: CallArg,
  ): Promise<ArtifactRecord | undefined>;
  policy(call?: CallArg): Promise<{ readonly policy: 'proceed' | 'request' }>;
}

export const ArtifactsV1 = ref<Artifacts>('artifacts/v1');

/* Artifacts cache (structural copy of `artifacts.cache/v1`) --------------- */

/** One entry `artifacts.cache/v1.ensure` takes: `artifacts/v1.read`'s shape. */
export interface ArtifactCacheEntry {
  readonly path: string;
  readonly sha256: string;
  readonly base64: string;
}

/** What one `ensure` left in the cache, and the entries it refused. */
export interface ArtifactCacheEnsureResult {
  readonly kept: number;
  readonly written: number;
  readonly failed: readonly {
    readonly path: string;
    readonly reason: 'invalid_path' | 'hash_mismatch' | 'write_failed';
    readonly message: string;
  }[];
}

/**
 * `artifacts.cache/v1` (desktopMain): writes a revision's entries under
 * `userData/artifacts/<artifactId>@<revision>/` once each SHA-256 is
 * confirmed, which is what `doric://app/artifacts/…` serves. The window
 * fetches the bytes from `artifacts/v1.read` and hands them over.
 */
export interface ArtifactsCache {
  ensure(
    input: {
      readonly artifactId: string;
      readonly revision: number;
      readonly entries: readonly ArtifactCacheEntry[];
    },
    call?: CallArg,
  ): Promise<ArtifactCacheEnsureResult>;
}

export const ArtifactsCacheV1 = ref<ArtifactsCache>('artifacts.cache/v1');

export interface ArtifactKinds {
  /**
   * Registers a kind; the release unregisters it. A duplicate id fails with
   * `registration_conflict`. A kind that declares `bodyTag` renders its body
   * inside the registry's frame: the frame creates `bodyTag` with its block
   * (`type` = `blockType`, `data` = the frame's data).
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
  list(call?: CallArg): Promise<
    readonly {
      readonly id: string;
      readonly title?: string;
      readonly blockType?: string;
      readonly bodyTag?: string;
      readonly header?: 'frame' | 'body';
    }[]
  >;
}

export const ArtifactKindV1 = ref<ArtifactKinds>('artifact.kind/v1');

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

/** The target kind a preview comment carries; read by whoever owns the target. */
export const ARTIFACT_TARGET_KIND = 'artifact';

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

/** The chat block type of one preview revision. */
export const PREVIEW_BLOCK_TYPE = 'papercraft.preview/v1';

/** The node element tag; the `papercraft` owner prefixes every tag. */
export const PAPERCRAFT_PREVIEW_TAG = 'papercraft-preview';

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
export const OPEN_CANVAS_COMMAND = 'papercraft.open-canvas/v1';

/**
 * The path window the canvas opens as. The window is opened from a
 * conversation, and it carries that conversation in its path: the Project
 * scopes every host call, and the Thread is the composer stack its comments
 * join and the log it watches.
 */
export const CANVAS_ROUTE = '/papercraft/:projectId/:threadId/:artifactId';

export const canvasPathOf = (input: {
  readonly projectId: string;
  readonly threadId: string;
  readonly artifactId: string;
}): string =>
  `/papercraft/${encodeURIComponent(input.projectId)}/${encodeURIComponent(
    input.threadId,
  )}/${encodeURIComponent(input.artifactId)}`;

/** The command that approves a revision under the `request` policy. */
export const APPROVE_COMMAND = 'papercraft.approve/v1';

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
  {
    command: APPROVE_COMMAND,
    key: 'CmdOrCtrl+Shift+Enter',
    label: 'Autorizar',
  },
] as const;

/** The composer stack item kind of a papercraft comment draft. */
export const PAPERCRAFT_COMMENT_KIND = 'papercraft-preview';

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

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * The target a papercraft stack item's `data` names: its `target`, else the
 * fields a draft written before the target was carried recorded
 * (`artifactId`, `revision`, `anchor`). `undefined` when neither names one.
 */
export const previewItemTargetOf = (
  data: unknown,
): CommentTarget | undefined => {
  const fields = recordOf(data);
  const target = recordOf(fields?.target);

  if (
    target !== undefined &&
    typeof target.id === 'string' &&
    target.id !== '' &&
    recordOf(target.anchor) !== undefined
  ) {
    return {
      kind:
        typeof target.kind === 'string' ? target.kind : ARTIFACT_TARGET_KIND,
      id: target.id,
      ...(typeof target.revision === 'number'
        ? { revision: target.revision }
        : {}),
      anchor: target.anchor as CommentAnchor,
    };
  }

  if (
    typeof fields?.artifactId !== 'string' ||
    fields.artifactId === '' ||
    typeof fields.revision !== 'number' ||
    recordOf(fields.anchor) === undefined
  ) {
    return undefined;
  }

  return {
    kind: ARTIFACT_TARGET_KIND,
    id: fields.artifactId,
    revision: fields.revision,
    anchor: fields.anchor as CommentAnchor,
  };
};

/** What the toolbar's revision reading shows: which revisions exist. */
export interface RevisionReading {
  /** Which revision is on screen. */
  readonly current: number;
  /** How many revisions exist. */
  readonly total: number;
  /** Every revision, ascending; the dropdown's items. */
  readonly list: readonly number[];
  /** Whether the revision on screen is already approved. */
  readonly approved: boolean;
}
