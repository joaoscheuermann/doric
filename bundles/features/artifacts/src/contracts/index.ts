// Public contract of the `artifacts` bundle: the Project's reviewable
// deliverables (`artifacts/v1`), the registry of artifact kinds
// (`artifact.kind/v1`), their durable events and the review policy.
//
// An artifact is durable state, not a transport: stable identity
// (`artifactId`), immutable revisions, the code anchors it touches and one
// durable event per transition. The bundle owns the registry; the bundle that
// owns a kind owns how that kind is produced. A revision's entries are its
// identity — `{ path, sha256 }`, never the bytes: the bytes live in the
// Project's work copy and only `read` serves them (base64, the mold of
// `doric.catalog/v1.artifact`).

import {
  type CallArg,
  type ContractId,
  type Disposable,
  defineEvent,
  defineSettings,
  disposableSchema,
  noInput,
  ref,
} from 'bundle/contracts';
import { z } from 'zod';

/** One anchor of the code an artifact touches. */
export interface ArtifactTarget {
  /** Workspace-relative path of the file the artifact touches. */
  readonly path: string;
  /** The first and last line of that file the anchor covers (the spec's form). */
  readonly lines?: readonly [number, number];
  /** One line of that file, when the anchor is a line. */
  readonly line?: number;
  /** A snippet of it, when naming the line by number would be brittle. */
  readonly snippet?: string;
}

/** Where the payload of a revision came from. */
export type ArtifactSource = 'html' | 'component' | 'site';

/**
 * The identity grammar of an artifact: lowercase segments separated by single
 * dashes. It is also a directory name of the work copy and of the desktop
 * cache, so nothing else is ever an artifact id.
 */
export const artifactIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Whether a revision-relative entry path stays inside the revision: one or
 * more `/`-separated segments, none empty, `.` or `..`, and none carrying a
 * backslash or NUL — so no leading `/` either. The registry writes entries
 * under `.doric/`, and the desktop cache under its own root, by this rule.
 */
export const isArtifactEntryPath = (path: string): boolean =>
  path !== '' &&
  path
    .split('/')
    .every(
      (segment) =>
        segment !== '' &&
        segment !== '.' &&
        segment !== '..' &&
        !segment.includes('\\') &&
        !segment.includes('\0'),
    );

/** The entry path schema every wire shape that names an entry uses. */
export const artifactEntryPathSchema = z.string().refine(isArtifactEntryPath, {
  message:
    'An entry path is relative segments without empty, ".", "..", backslash or NUL parts.',
});

/** The artifact id schema every wire shape that names an artifact uses. */
export const artifactIdSchema = z
  .string()
  .regex(artifactIdPattern, { message: 'Not an artifact id.' });

/**
 * One entry of a revision: the artifact-relative path of a payload file and
 * the sha256 of its bytes. Entries are identity — events and manifests carry
 * them, never the bytes.
 */
export interface ArtifactEntry {
  readonly path: string;
  readonly sha256: string;
}

/**
 * The bytes of one entry, as `create`/`revise` receive them once, so the
 * registry can write them into the work copy. The durable event carries the
 * entry's hash only.
 */
export interface ArtifactFile {
  readonly path: string;
  /** The file's bytes, base64 (keeps the wire envelope JSON). */
  readonly base64: string;
}

/**
 * One entry as `read` serves it: its hash and, when the Project's work copy
 * still holds the bytes, the bytes themselves — the mold of
 * `doric.catalog/v1.artifact` (`{ sha256, base64 }`).
 */
export interface ArtifactReadEntry extends ArtifactEntry {
  /**
   * The entry's bytes, base64, when the work copy holds them and they hash to
   * `sha256`. A derived kind (a `preview`) reconstructs its form elsewhere, so
   * a revision whose bytes are gone reads without `base64` — the event still
   * names what existed.
   */
  readonly base64?: string;
}

/** One artifact as a reader sees it: the artifact on one of its revisions. */
export interface ArtifactRecord {
  readonly artifactId: string;
  readonly kind: string;
  readonly title: string;
  /** The revision this record describes, 1-based. */
  readonly revision: number;
  /** How many revisions the artifact has. */
  readonly revisions: number;
  readonly targets: readonly ArtifactTarget[];
  /** The entries of this revision: their paths and hashes, never bytes. */
  readonly entries: readonly ArtifactEntry[];
  readonly source?: ArtifactSource;
  /** Workspace path of this revision's payload, when the kind writes one. */
  readonly path?: string;
  /** The entry file of this revision, relative to `path`. */
  readonly entry?: string;
  /** What the caller asked for in `notes` on `create`. */
  readonly notes?: string;
  /** The note this revision was published with, when it was a `revise`. */
  readonly changeNote?: string;
  /**
   * The review state of this revision: `approved` only once the review
   * gesture was recorded for it under `request`. A new revision starts open.
   */
  readonly state: 'open' | 'approved';
  /** ISO-8601, when the artifact was created. */
  readonly createdAt: string;
  /** The bundle that created it, as the call's caller. */
  readonly createdBy?: string;
}

/** The record of one revision plus the bytes of its entries. */
export interface ArtifactRevisionRead extends Omit<ArtifactRecord, 'entries'> {
  readonly entries: readonly ArtifactReadEntry[];
}

export interface ArtifactCreateInput {
  /** A caller-chosen identity; absent, one is derived from the title. */
  readonly artifactId?: string;
  readonly kind: string;
  readonly title: string;
  /** Absent, the kind's materialization declares them, or the revision has none. */
  readonly targets?: readonly ArtifactTarget[];
  readonly source?: ArtifactSource;
  readonly path?: string;
  readonly entry?: string;
  readonly notes?: string;
  /**
   * The ready entries of revision 1, when the caller built them itself (the
   * `papercraft` tool does, through `papercraft.previews/v1.build`).
   */
  readonly entries?: readonly ArtifactEntry[];
  /**
   * The bytes of the entries this call writes into the work copy, once: the
   * registry verifies each file's hash against the entry of the same path
   * before writing it.
   */
  readonly files?: readonly ArtifactFile[];
  /**
   * The kind's payload, instead of ready entries: the registry validates it
   * against the kind's `payload` schema and asks the kind's `materialize` for
   * the revision's entries (and the bytes to write).
   */
  readonly payload?: unknown;
}

export interface ArtifactReviseInput {
  readonly artifactId: string;
  readonly changeNote?: string;
  /** Absent, the previous revision's anchors carry over. */
  readonly targets?: readonly ArtifactTarget[];
  /** Absent, the previous revision's payload place carries over. */
  readonly path?: string;
  readonly source?: ArtifactSource;
  readonly entry?: string;
  /** Absent, the previous revision's entries carry over. */
  readonly entries?: readonly ArtifactEntry[];
  /** The bytes this revision writes into the work copy, as in `create`. */
  readonly files?: readonly ArtifactFile[];
  /** The kind's payload for this revision, as in `create`. */
  readonly payload?: unknown;
}

export interface ArtifactReadInput {
  readonly artifactId: string;
  /** Absent, the newest revision. */
  readonly revision?: number;
}

export interface ArtifactListInput {
  /** Absent, every artifact of the Project's sandbox. */
  readonly threadId?: string;
}

export interface ArtifactApproveInput {
  readonly artifactId: string;
  readonly revision: number;
}

export interface ArtifactAwaitApprovalInput {
  readonly artifactId: string;
  readonly revision: number;
  /** Absent, the wait lasts as long as the call does. */
  readonly timeoutMs?: number;
}

/** The review policy in force: `proceed` publishes and moves on, `request` waits. */
export type ArtifactReviewPolicyValue = {
  readonly policy: 'proceed' | 'request';
  /** 1.1.0: kinds that run under `proceed` in every Project. Absent from a 1.0.0 registry. */
  readonly exemptKinds?: readonly string[];
};

/**
 * `artifacts/v1` (host), cardinality `one`. No method acquires a lease: the
 * registry reads and writes the Project's one sandbox through the calling
 * Project's lease, and a Project without one answers with its lease state.
 */
export interface Artifacts {
  /** Writes revision 1 and publishes `artifacts.created/v1`. */
  create(input: ArtifactCreateInput, call?: CallArg): Promise<ArtifactRecord>;
  /** Adds the next revision, leaving every earlier one untouched. */
  revise(input: ArtifactReviseInput, call?: CallArg): Promise<ArtifactRecord>;
  /**
   * The record of one revision with the bytes of its entries, or undefined
   * when the artifact or the revision does not exist.
   */
  read(
    input: ArtifactReadInput,
    call?: CallArg,
  ): Promise<ArtifactRevisionRead | undefined>;
  /**
   * The Project's artifacts, newest revision each. Without `threadId`, a call
   * scoped to a Thread lists that Thread's artifacts and any other call the
   * whole Project's. An artifact whose manifest cannot be read is skipped.
   */
  list(
    input: ArtifactListInput,
    call?: CallArg,
  ): Promise<readonly ArtifactRecord[]>;
  /**
   * Every revision of one artifact, oldest first, without bytes: what the
   * frame reads a revision's review state from. Empty when the artifact does
   * not exist.
   */
  revisions(
    input: { readonly artifactId: string },
    call?: CallArg,
  ): Promise<readonly ArtifactRecord[]>;
  /**
   * Under `request`, records `artifacts.approved/v1` for one revision and
   * makes that revision — only that one — `approved`. Under `proceed` there
   * is no approval: nothing is recorded and the revision stays as it was.
   * Repeating it for a revision already approved records nothing twice.
   */
  approve(
    input: ArtifactApproveInput,
    call?: CallArg,
  ): Promise<ArtifactRecord | undefined>;
  /**
   * Resolves once the revision may reach the Project's code: at once under
   * `proceed` or when the revision is already approved, otherwise when
   * `approve` records it — or with the revision still `open` when
   * `timeoutMs` passes. Undefined when the artifact or revision does not
   * exist. What a kind's tool awaits under `request` before writing code.
   */
  awaitApproval(
    input: ArtifactAwaitApprovalInput,
    call?: CallArg,
  ): Promise<ArtifactRecord | undefined>;
  /** The policy of the calling Project: what the UI reads before offering the gesture. */
  policy(call?: CallArg): Promise<ArtifactReviewPolicyValue>;
  /**
   * Writes the review policy of the calling Project (or, for a call scoped to
   * no Project, the default of every Project without a choice) into
   * `artifacts.review-policy/v1` — the settings space this bundle registers,
   * so a window reaches it through the registry and not through
   * `settings/v1`, which the desktop never sees.
   */
  setPolicy(
    input: ArtifactReviewPolicyValue,
    call?: CallArg,
  ): Promise<ArtifactReviewPolicyValue>;
  /**
   * Records `artifacts.applied/v1`: the revision's files reached the code.
   * Under `request`, a revision not yet approved is refused.
   */
  apply(
    input: {
      readonly artifactId: string;
      readonly revision: number;
      readonly files: readonly string[];
    },
    call?: CallArg,
  ): Promise<ArtifactRecord | undefined>;
}

/** The closed zod schema a kind validates its payload with; opaque to the registry. */
export type ArtifactKindPayload = z.ZodType;

/** What a kind's materialization answers: entries and anchors, plus bytes. */
export interface ArtifactMaterialization {
  /** The entries of the revision the kind derived. */
  readonly entries: readonly ArtifactEntry[];
  /** The anchors the kind declares for the revision, when it does. */
  readonly targets?: readonly ArtifactTarget[];
  /**
   * The bytes the kind hands the registry to write into the work copy. Each
   * file must hash to the entry of the same path.
   */
  readonly files?: readonly ArtifactFile[];
}

/**
 * The kind's own derivation of a revision from its payload: `(input, call)`,
 * as the docs state it, with the artifact's identity for kinds that key their
 * storage by it.
 */
export type ArtifactKindMaterialize = (
  input: {
    /**
     * The payload as the kind's schema parsed it (defaults and transforms
     * applied), or as the caller sent it when the kind declares no schema.
     */
    readonly payload: unknown;
    readonly artifactId: string;
    readonly revision: number;
    readonly title: string;
  },
  call?: CallArg,
) => Promise<ArtifactMaterialization> | ArtifactMaterialization;

/** One kind of artifact a bundle registers. */
export interface ArtifactKindDescriptor {
  readonly id: string;
  readonly title?: string;
  /** The kind's payload schema, when its materialization needs one. */
  readonly payload?: ArtifactKindPayload;
  /** The kind's own derivation of a revision from its payload. */
  readonly materialize?: ArtifactKindMaterialize;
  /**
   * The block type of the kind's body: the `type` of the block the registry's
   * frame hands the body element (`bodyTag`). Without `bodyTag`, a kind that
   * declares one is a legacy kind that projects and renders its own node (as
   * `papercraft`'s client did for `preview`), and the registry's client leaves
   * the created/revised pair to it.
   */
  readonly blockType?: string;
  /**
   * The custom element (defined by the kind's own client part, with `ui/v1`)
   * that renders the body of one revision inside the registry's frame. The
   * frame creates it with `ui/v1.create(bodyTag, { block })`, where `block` is
   * the frame's own block with `type` set to `blockType` — `data` is an
   * `ArtifactFrameData`. "The frame is the registry's, the body is the kind's."
   */
  readonly bodyTag?: string;
  /**
   * Who draws the header of a revision: `frame` (the default) — the registry's
   * bar with the title, kind, revision, review state and `Comentar` — or
   * `body`, for a kind whose body overlays its own header. With `body` the
   * frame draws no bar; it keeps `Autorizar` (under `request`, for an open
   * revision) below the body.
   */
  readonly header?: ArtifactKindHeader;
}

/** Who draws a kind's header: the registry's frame, or the kind's body. */
export type ArtifactKindHeader = 'frame' | 'body';

/**
 * `artifact.kind/v1` (host), cardinality `one`: the registry a bundle that owns
 * an artifact kind declares it in, so the kind is known before any artifact of
 * it exists. The registry keeps names and the kind's own providers; it
 * interprets neither a kind nor an artifact, and an artifact whose kind nobody
 * registered is still stored, exactly as the log stores it.
 *
 * `register` answers a `Disposable`: the kind lives until it is disposed or
 * the registering generation ends (the platform tracks the disposable on the
 * caller's generation). The same bundle registering the same id again — its
 * next generation — replaces the declaration, title and block type included;
 * another bundle claiming an id in use is a `registration_conflict`.
 */
export interface ArtifactKindRegistry {
  register(
    input: {
      readonly id: string;
      readonly title?: string;
      readonly payload?: ArtifactKindPayload;
      readonly materialize?: ArtifactKindMaterialize;
      readonly blockType?: string;
      readonly bodyTag?: string;
      readonly header?: ArtifactKindHeader;
    },
    call?: CallArg,
  ): Promise<Disposable>;
  list(call?: CallArg): Promise<readonly ArtifactKindDescriptor[]>;
}

/**
 * The target kind an artifact revision is commented with: the `kind` of the
 * `comments/v1` target that names a revision, `id` being the `artifactId` and
 * `revision` the revision. The comments registry never looks inside it; this
 * bundle's own reducer does, to count what is still pending.
 */
export const ARTIFACT_TARGET_KIND = 'artifact';

export const artifactTargetSchema: z.ZodType<ArtifactTarget, ArtifactTarget> =
  z.looseObject({
    path: z.string(),
    lines: z.tuple([z.number().int(), z.number().int()]).optional(),
    line: z.number().int().optional(),
    snippet: z.string().optional(),
  });

export const artifactEntrySchema: z.ZodType<ArtifactEntry, ArtifactEntry> =
  z.looseObject({
    path: artifactEntryPathSchema,
    sha256: z.string(),
  });

export const artifactFileSchema: z.ZodType<ArtifactFile, ArtifactFile> =
  z.looseObject({
    path: artifactEntryPathSchema,
    base64: z.string(),
  });

export const artifactSourceSchema = z.enum(['html', 'component', 'site']);

const artifactBaseFields = {
  artifactId: z.string(),
  kind: z.string(),
  title: z.string(),
  revision: z.number().int(),
  revisions: z.number().int(),
  targets: z.array(artifactTargetSchema),
  source: artifactSourceSchema.optional(),
  path: z.string().optional(),
  entry: z.string().optional(),
  notes: z.string().optional(),
  /** The note this revision was published with, when it was a `revise`. */
  changeNote: z.string().optional(),
  state: z.enum(['open', 'approved']),
  createdAt: z.string(),
  createdBy: z.string().optional(),
} as const;

export const artifactRecordSchema: z.ZodType<ArtifactRecord, ArtifactRecord> =
  z.looseObject({
    ...artifactBaseFields,
    entries: z.array(artifactEntrySchema),
  });

const artifactReadEntrySchema: z.ZodType<ArtifactReadEntry, ArtifactReadEntry> =
  z.looseObject({
    path: artifactEntryPathSchema,
    sha256: z.string(),
    base64: z.string().optional(),
  });

export const artifactRevisionReadSchema: z.ZodType<
  ArtifactRevisionRead,
  ArtifactRevisionRead
> = z.looseObject({
  ...artifactBaseFields,
  entries: z.array(artifactReadEntrySchema),
});

const artifactCreateInputSchema: z.ZodType<
  ArtifactCreateInput,
  ArtifactCreateInput
> = z.looseObject({
  artifactId: artifactIdSchema.optional(),
  kind: z.string(),
  title: z.string(),
  targets: z.array(artifactTargetSchema).optional(),
  source: artifactSourceSchema.optional(),
  path: z.string().optional(),
  entry: z.string().optional(),
  notes: z.string().optional(),
  entries: z.array(artifactEntrySchema).optional(),
  files: z.array(artifactFileSchema).optional(),
  payload: z.unknown().optional(),
});

const artifactReviseInputSchema: z.ZodType<
  ArtifactReviseInput,
  ArtifactReviseInput
> = z.looseObject({
  artifactId: artifactIdSchema,
  changeNote: z.string().optional(),
  targets: z.array(artifactTargetSchema).optional(),
  path: z.string().optional(),
  source: artifactSourceSchema.optional(),
  entry: z.string().optional(),
  entries: z.array(artifactEntrySchema).optional(),
  files: z.array(artifactFileSchema).optional(),
  payload: z.unknown().optional(),
});

const artifactReadInputSchema: z.ZodType<ArtifactReadInput, ArtifactReadInput> =
  z.looseObject({
    artifactId: artifactIdSchema,
    revision: z.number().int().positive().optional(),
  });

const artifactListInputSchema: z.ZodType<ArtifactListInput, ArtifactListInput> =
  z.looseObject({
    threadId: z.string().optional(),
  });

const artifactApproveInputSchema: z.ZodType<
  ArtifactApproveInput,
  ArtifactApproveInput
> = z.looseObject({
  artifactId: artifactIdSchema,
  revision: z.number().int().positive(),
});

const artifactAwaitApprovalInputSchema: z.ZodType<
  ArtifactAwaitApprovalInput,
  ArtifactAwaitApprovalInput
> = z.looseObject({
  artifactId: artifactIdSchema,
  revision: z.number().int().positive(),
  timeoutMs: z.number().int().nonnegative().optional(),
});

const artifactRevisionsInputSchema = z.looseObject({
  artifactId: artifactIdSchema,
});

const artifactApplyInputSchema = z.looseObject({
  artifactId: artifactIdSchema,
  revision: z.number().int().positive(),
  files: z.array(z.string()),
});

export const artifactPolicySchema: z.ZodType<
  ArtifactReviewPolicyValue,
  ArtifactReviewPolicyValue
> = z.looseObject({
  policy: z.enum(['proceed', 'request']),
  exemptKinds: z.array(z.string()).optional(),
});

/** A policy write carries the whole value: the choice names itself. */
export const artifactPolicyInputSchema: z.ZodType<
  ArtifactReviewPolicyValue,
  ArtifactReviewPolicyValue
> = z.object({ policy: z.enum(['proceed', 'request']) }).strict();

export const artifactsMethods = {
  create: { input: artifactCreateInputSchema, output: artifactRecordSchema },
  revise: { input: artifactReviseInputSchema, output: artifactRecordSchema },
  read: {
    input: artifactReadInputSchema,
    output: artifactRevisionReadSchema.optional(),
  },
  list: {
    input: artifactListInputSchema,
    output: z.array(artifactRecordSchema),
  },
  revisions: {
    input: artifactRevisionsInputSchema,
    output: z.array(artifactRecordSchema),
  },
  approve: {
    input: artifactApproveInputSchema,
    output: artifactRecordSchema.optional(),
  },
  awaitApproval: {
    input: artifactAwaitApprovalInputSchema,
    output: artifactRecordSchema.optional(),
  },
  policy: { input: noInput, output: artifactPolicySchema },
  setPolicy: { input: artifactPolicyInputSchema, output: artifactPolicySchema },
  apply: {
    input: artifactApplyInputSchema,
    output: artifactRecordSchema.optional(),
  },
} as const;

export const ArtifactsV1 = ref<Artifacts>('artifacts/v1');

const kindPayloadSchema = z.custom<ArtifactKindPayload>(
  (value) => value instanceof z.ZodType,
  { message: 'Expected a zod schema.' },
);

const kindMaterializeSchema = z.custom<ArtifactKindMaterialize>(
  (value) => typeof value === 'function',
  { message: 'Expected a materialize function.' },
);

const artifactKindRegisterInputSchema = z.looseObject({
  id: z.string(),
  title: z.string().optional(),
  payload: kindPayloadSchema.optional(),
  materialize: kindMaterializeSchema.optional(),
  blockType: z.string().optional(),
  bodyTag: z.string().optional(),
  header: z.enum(['frame', 'body']).optional(),
});

const artifactKindDescriptorSchema: z.ZodType<
  ArtifactKindDescriptor,
  ArtifactKindDescriptor
> = z.looseObject({
  id: z.string(),
  title: z.string().optional(),
  blockType: z.string().optional(),
  bodyTag: z.string().optional(),
  header: z.enum(['frame', 'body']).optional(),
});

export const artifactKindMethods = {
  register: {
    input: artifactKindRegisterInputSchema,
    output: disposableSchema,
  },
  list: {
    input: noInput,
    output: z.array(artifactKindDescriptorSchema),
    expose: 'desktop',
  },
} as const;

export const ArtifactKindV1 = ref<ArtifactKindRegistry>('artifact.kind/v1');

// Desktop cache ----------------------------------------------------------------

/**
 * One compiled entry of a revision as `artifacts.cache/v1` takes it: the wire
 * shape `artifacts/v1.read` returns, in the mold of `doric.catalog/v1.artifact`.
 */
export interface ArtifactCacheEntry {
  /** Revision-relative path of the compiled file. */
  readonly path: string;
  /** The SHA-256 of the decoded bytes, lowercase hex. */
  readonly sha256: string;
  /** The file's bytes, base64 (keeps the envelope JSON). */
  readonly base64: string;
}

/** Why one entry of an `ensure` did not reach the cache. */
export type ArtifactCacheEntryFailureReason =
  | 'invalid_path'
  | 'hash_mismatch'
  | 'write_failed';

/** One entry the cache refused: the path, the reason and the sentence. */
export interface ArtifactCacheEntryFailure {
  readonly path: string;
  readonly reason: ArtifactCacheEntryFailureReason;
  readonly message: string;
}

/** The `ensure` input: one revision as its entries. */
export interface ArtifactCacheEnsureInput {
  readonly artifactId: string;
  readonly revision: number;
  readonly entries: readonly ArtifactCacheEntry[];
}

/** What one `ensure` call left in the cache. */
export interface ArtifactCacheEnsureResult {
  /** Entries already cached with the hash they declare. */
  readonly kept: number;
  /** Entries verified and written now. */
  readonly written: number;
  /** Entries the cache refused, with the reason of each. */
  readonly failed: readonly ArtifactCacheEntryFailure[];
}

const artifactCacheEntrySchema: z.ZodType<
  ArtifactCacheEntry,
  ArtifactCacheEntry
> = z
  .object({
    path: artifactEntryPathSchema,
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    base64: z.string(),
  })
  .strict();

const artifactCacheFailureSchema: z.ZodType<
  ArtifactCacheEntryFailure,
  ArtifactCacheEntryFailure
> = z
  .object({
    path: z.string(),
    reason: z.enum(['invalid_path', 'hash_mismatch', 'write_failed']),
    message: z.string(),
  })
  .strict();

export const artifactCacheEnsureInputSchema: z.ZodType<
  ArtifactCacheEnsureInput,
  ArtifactCacheEnsureInput
> = z
  .object({
    artifactId: artifactIdSchema,
    revision: z.number().int().positive(),
    entries: z.array(artifactCacheEntrySchema),
  })
  .strict();

export const artifactCacheEnsureResultSchema: z.ZodType<
  ArtifactCacheEnsureResult,
  ArtifactCacheEnsureResult
> = z
  .object({
    kept: z.number().int().nonnegative(),
    written: z.number().int().nonnegative(),
    failed: z.array(artifactCacheFailureSchema),
  })
  .strict();

/**
 * `artifacts.cache/v1` (desktopMain), cardinality `one`: the verified cache of
 * a revision's compiled entries. A window fetches a revision's entries from
 * the host's `artifacts/v1.read` and hands them to `ensure`, which writes each
 * file only once its SHA-256 is confirmed; the
 * `doric://app/artifacts/<artifactId>@<revision>/…` route then serves what
 * passed. The schemas are strict on purpose: an old record without entries
 * fails validation instead of silently caching nothing.
 */
export interface ArtifactsCache {
  ensure(
    input: ArtifactCacheEnsureInput,
    call?: CallArg,
  ): Promise<ArtifactCacheEnsureResult>;
}

export const ArtifactsCacheV1 = ref<ArtifactsCache>('artifacts.cache/v1');

export const artifactsCacheMethods = {
  ensure: {
    input: artifactCacheEnsureInputSchema,
    output: artifactCacheEnsureResultSchema,
    expose: 'desktop',
  },
} as const;

// Events ----------------------------------------------------------------------

/**
 * A new artifact exists at revision 1. The payload carries the revision's
 * anchors and entries — `path` + `sha256`, never the bytes — and, when the
 * revision was materialized from one, the kind's payload as its schema parsed
 * it.
 */
export const artifactsCreatedEvent = defineEvent({
  type: 'artifacts.created/v1',
  payload: z.looseObject({
    artifactId: z.string(),
    revision: z.number().int(),
    kind: z.string(),
    title: z.string(),
    targets: z.array(artifactTargetSchema),
    entries: z.array(artifactEntrySchema),
    source: artifactSourceSchema.optional(),
    path: z.string().optional(),
    entry: z.string().optional(),
    notes: z.string().optional(),
    payload: z.unknown().optional(),
  }),
});

/**
 * The artifact gained a revision; every earlier revision still exists. The
 * payload carries the revision's resolved anchors and entries — the log is the
 * durable truth, so replay rebuilds the revision without the work copy — and
 * the artifact's kind and title, since the revising Thread's log may hold no
 * `created` (another Thread created it). Logs written before carry neither.
 */
export const artifactsRevisedEvent = defineEvent({
  type: 'artifacts.revised/v1',
  payload: z.looseObject({
    artifactId: z.string(),
    revision: z.number().int(),
    kind: z.string().optional(),
    title: z.string().optional(),
    changeNote: z.string().optional(),
    targets: z.array(artifactTargetSchema),
    entries: z.array(artifactEntrySchema),
    payload: z.unknown().optional(),
  }),
});

/** The revision's files were written into the Project's code. */
export const artifactsAppliedEvent = defineEvent({
  type: 'artifacts.applied/v1',
  payload: z.looseObject({
    artifactId: z.string(),
    revision: z.number().int(),
    files: z.array(z.string()),
  }),
});

/**
 * The review gesture on one revision. It exists only under the `request`
 * policy, and at most once per revision.
 */
export const artifactsApprovedEvent = defineEvent({
  type: 'artifacts.approved/v1',
  payload: z.looseObject({
    artifactId: z.string(),
    revision: z.number().int(),
    scope: z.string(),
  }),
});

/** The `scope` an approval carries: it covers the revision it names. */
export const artifactApprovalScope = 'revision';

// Settings --------------------------------------------------------------------

const reviewPolicyChoice = z.enum(['proceed', 'request']);

/**
 * `artifacts.review-policy/v1`: the review policy of each Project. `policy` is
 * the choice of every Project without one of its own — `proceed` by default
 * (Doric is YOLO by default); `projects` holds each Project's own choice, by
 * `projectId`. `settings/v1` keeps one value per space, so the per-Project
 * choice lives inside it.
 */
export const artifactReviewPolicy = defineSettings({
  id: 'artifacts.review-policy/v1',
  schema: z
    .object({
      policy: reviewPolicyChoice.default('proceed'),
      projects: z.record(z.string(), reviewPolicyChoice).default({}),
      exemptKinds: z.array(z.string().min(1)).default(['diagram']),
    })
    .strict(),
});

export type ArtifactReviewPolicySettings = z.output<
  typeof artifactReviewPolicy.schema
>;

/** The policy a Project without an explicit choice runs. */
export const defaultArtifactReviewPolicy: ArtifactReviewPolicySettings = {
  policy: 'proceed',
  projects: {},
  exemptKinds: ['diagram'],
};

/** With `kind` in `settings.exemptKinds`, 'proceed'; otherwise the Project's choice, else the default. */
export const reviewPolicyOf = (
  settings: ArtifactReviewPolicySettings,
  projectId: string | undefined,
  kind?: string,
): ArtifactReviewPolicyValue['policy'] =>
  kind !== undefined && settings.exemptKinds.includes(kind)
    ? 'proceed'
    : ((projectId === undefined ? undefined : settings.projects[projectId]) ??
      settings.policy);

/** The contract IDs this bundle publishes, for readers of the manifest. */
export const artifactsContractIds = {
  service: ArtifactsV1.id as ContractId,
  kind: ArtifactKindV1.id as ContractId,
  reviewPolicy: artifactReviewPolicy.id,
} as const;
