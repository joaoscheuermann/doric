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

import { type CallArg, type MethodSpecs, ref } from 'bundle/contracts';
import { z } from 'zod';

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
    snippet: z.string().optional(),
  })
  .strict();

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

export interface Artifacts {
  create(
    input: {
      readonly artifactId?: string;
      readonly kind: string;
      readonly title: string;
      readonly targets: readonly ArtifactTarget[];
      readonly source?: PreviewSource;
      readonly path?: string;
      readonly entry?: string;
      readonly notes?: string;
    },
    call?: CallArg,
  ): Promise<ArtifactRecord>;
  read(
    input: { readonly artifactId: string; readonly revision?: number },
    call?: CallArg,
  ): Promise<ArtifactRevisionRead | undefined>;
  approve(
    input: { readonly artifactId: string; readonly revision: number },
    call?: CallArg,
  ): Promise<ArtifactRecord | undefined>;
  policy(call?: CallArg): Promise<{ readonly policy: 'proceed' | 'request' }>;
}

export const ArtifactsV1 = ref<Artifacts>('artifacts/v1');

export interface ArtifactKinds {
  /** Registers a kind. A duplicate id fails with `registration_conflict`. */
  register(
    input: { readonly id: string; readonly title?: string },
    call?: CallArg,
  ): unknown;
  list(
    call?: CallArg,
  ): readonly { readonly id: string; readonly title?: string }[];
}

export const ArtifactKindV1 = ref<ArtifactKinds>('artifact.kind/v1');

/* Comments (structural copy of `comments/v1`) ----------------------------- */

export const commentAnchorSchema = z
  .object({
    form: z.enum(['source', 'selector', 'point', 'range']),
    path: z.string().optional(),
    line: z.number().int().positive().optional(),
    selector: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    label: z.string().optional(),
    text: z.string().optional(),
  })
  .strict();

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
}

/** The target kind a preview comment carries; read by whoever owns the target. */
export const ARTIFACT_TARGET_KIND = 'artifact';

export interface Comments {
  add(input: CommentAddInput, call?: CallArg): Promise<Comment>;
}

export const CommentsV1 = ref<Comments>('comments/v1');

/* Names the client and desktop parts share --------------------------------- */

/** The chat block type of one preview revision. */
export const PREVIEW_BLOCK_TYPE = 'papercraft.preview/v1';

/** The node element tag; the `papercraft` owner prefixes every tag. */
export const PAPERCRAFT_PREVIEW_TAG = 'papercraft-preview';

/** The canvas element tag of the `/papercraft/:artifactId` route. */
export const PAPERCRAFT_CANVAS_TAG = 'papercraft-canvas';

/** The window command that opens or focuses the canvas at a preview. */
export const OPEN_CANVAS_COMMAND = 'papercraft.open-canvas/v1';

/** The path window the canvas opens as, parameterised by the artifact id. */
export const CANVAS_ROUTE = '/papercraft/:artifactId';

export const canvasPathOf = (artifactId: string): string =>
  `/papercraft/${artifactId}`;

/** The command that approves a revision under the `request` policy. */
export const APPROVE_COMMAND = 'papercraft.approve/v1';

/* The command bar (papercraft.md, "A barra de comandos") ------------------ */

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
  { command: APPROVE_COMMAND, key: 'CmdOrCtrl+Enter', label: 'Autorizar' },
] as const;

/** The composer stack item kind of a papercraft comment draft. */
export const PAPERCRAFT_COMMENT_KIND = 'papercraft-preview';

/** The element chat draws one composer stack item with. */
export const PAPERCRAFT_COMMENT_CARD_TAG = 'papercraft-comment-card';

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
