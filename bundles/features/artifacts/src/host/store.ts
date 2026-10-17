// Where the registry keeps its work copy: `/workspace/.doric/artifacts/
// <artifactId>/artifact.json` plus each revision's payload files under
// `<artifactId>/<revision>/<path>`, reached through the Project's sandbox lease
// (`runtime.lease/v1.withLease`) exactly as `files` reaches the workspace —
// never acquiring a lease, and answering the lease state when there is none.
// The directory belongs to the app, not to the user's code — it is born
// Git-ignored (`.doric/.gitignore`, `*`) — and the log stays the durable
// truth: this manifest is regenerable and its revisions are never rewritten.
//
// A revision's bytes live in a directory of their own, so revision 2 never
// overwrites what revision 1 named. A work copy written before that layout
// kept every entry at the artifact's root (`<artifactId>/<path>`); reads still
// fall back to it, and the hash check decides whether those bytes still are
// the revision's.

import { createHash } from 'node:crypto';

import { type Call, ContractError, type Services } from 'bundle/contracts';
import {
  type LeaseOutcome,
  type LeaseTask,
  RuntimeLeaseV1,
} from 'runtime/contracts';
import { z } from 'zod';

import {
  type ArtifactEntry,
  type ArtifactSource,
  type ArtifactTarget,
  artifactEntrySchema,
  artifactIdPattern,
  artifactSourceSchema,
  artifactTargetSchema,
  isArtifactEntryPath,
} from '../contracts/index.js';

/** The directory of a Project's artifacts, relative to its workspace root. */
export const artifactsDirectory = '.doric/artifacts';

/** The Git ignore that keeps the app's directory out of the user's code. */
export const dotDoricGitignore = '.doric/.gitignore';

/** What `.doric/.gitignore` says: the whole directory is app state. */
export const DOT_DORIC_IGNORE = '*';

/** The sha256 of a payload's bytes, lowercase hex. */
export const sha256Of = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

/** One revision of the stored manifest; earlier revisions are never rewritten. */
export interface StoredArtifactRevision {
  readonly revision: number;
  readonly targets: readonly ArtifactTarget[];
  /** The entries of this revision: their paths and hashes, never the bytes. */
  readonly entries: readonly ArtifactEntry[];
  readonly source?: ArtifactSource;
  readonly path?: string;
  readonly entry?: string;
  readonly notes?: string;
  readonly changeNote?: string;
  /** Set once `artifacts.approved/v1` was recorded for this revision. */
  readonly approved?: boolean;
  readonly createdAt: string;
}

/**
 * `artifact.json`: the artifact's identity and the whole list of its revisions
 * — each with its anchors, entries and review state. `threadId` and
 * `promptId` are the provenance of the creation, so `list` can answer a
 * Thread's own artifacts and a later transition knows which Thread log the
 * artifact's events belong to.
 */
export interface StoredArtifact {
  readonly manifestVersion: 1;
  readonly artifactId: string;
  readonly kind: string;
  readonly title: string;
  readonly createdAt: string;
  readonly createdBy?: string;
  readonly threadId?: string;
  readonly promptId?: string;
  readonly revisions: readonly StoredArtifactRevision[];
}

/** What reading one manifest found. */
export type LoadedArtifact =
  | { readonly status: 'missing' }
  | { readonly status: 'unreadable' }
  | { readonly status: 'ok'; readonly artifact: StoredArtifact };

/** One file of a revision, as the store writes it: bytes, never text. */
export interface RevisionFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/** The work copy of one Project's artifacts. */
export interface ArtifactStore {
  load(artifactId: string): Promise<LoadedArtifact>;
  /** Every artifact whose manifest reads; an unreadable one is skipped. */
  list(): Promise<readonly StoredArtifact[]>;
  /**
   * The bytes of one entry, when the work copy still holds bytes that hash to
   * `sha256`: in each of `revisions`' directories, in the order given, then
   * at the artifact root where the first layout kept every entry.
   */
  readEntry(
    artifactId: string,
    path: string,
    sha256: string,
    revisions: readonly number[],
  ): Promise<Uint8Array | undefined>;
  /** Writes one revision's files into its own directory. */
  writeRevision(
    artifactId: string,
    revision: number,
    files: readonly RevisionFile[],
  ): Promise<void>;
  /** Removes one revision's directory: the rollback of a failed transition. */
  removeRevision(artifactId: string, revision: number): Promise<void>;
  /** Writes the manifest; `undefined` removes the artifact's directory. */
  writeManifest(
    artifactId: string,
    artifact: StoredArtifact | undefined,
  ): Promise<void>;
}

const storedArtifactSchema = z.looseObject({
  manifestVersion: z.literal(1),
  artifactId: z.string().regex(artifactIdPattern),
  kind: z.string(),
  title: z.string(),
  // The artifact-wide review state of the first layout, read only to carry
  // its one approval over to the revision it named.
  state: z.enum(['open', 'approved']).optional(),
  approvedRevision: z.number().int().optional(),
  createdAt: z.string(),
  createdBy: z.string().optional(),
  threadId: z.string().optional(),
  promptId: z.string().optional(),
  revisions: z
    .array(
      z.looseObject({
        revision: z.number().int().positive(),
        targets: z.array(artifactTargetSchema),
        entries: z.array(artifactEntrySchema),
        source: artifactSourceSchema.optional(),
        path: z.string().optional(),
        entry: z.string().optional(),
        notes: z.string().optional(),
        changeNote: z.string().optional(),
        approved: z.boolean().optional(),
        createdAt: z.string(),
      }),
    )
    .min(1),
});

/** A parsed manifest in the current shape, whatever layout wrote it. */
const storedOf = (
  parsed: z.output<typeof storedArtifactSchema>,
): StoredArtifact => {
  const { state, approvedRevision, ...rest } = parsed;
  const legacyApproved = state === 'approved' ? approvedRevision : undefined;

  return {
    ...rest,
    manifestVersion: 1,
    revisions: parsed.revisions.map((revision) =>
      revision.revision === legacyApproved
        ? { ...revision, approved: true }
        : revision,
    ),
  } as StoredArtifact;
};

/** The leased sandbox a `withLease` task receives. */
type Sandbox = Parameters<LeaseTask<unknown>>[0];

const withoutTrailingSlash = (value: string): string =>
  value.replace(/\/+$/u, '');

/** The lease state a store operation met instead of a sandbox. */
export const leaseUnavailable = (
  status: Exclude<LeaseOutcome<unknown>['status'], 'ready'>,
): ContractError =>
  new ContractError(
    'unavailable',
    `The Project has no sandbox lease to reach its artifacts (${status}).`,
    { lease: status },
  );

/** Whether an error is the store's own "no lease" answer. */
export const isLeaseUnavailable = (error: unknown): boolean =>
  error instanceof ContractError &&
  error.code === 'unavailable' &&
  typeof (error.details as { lease?: unknown } | undefined)?.lease === 'string';

/**
 * The artifact store of the Project `call` is scoped to. Every operation runs
 * on that Project's current lease (`withLease`), which never acquires one; a
 * Project without one rejects with `unavailable` and the lease state in
 * `details.lease`, which `read` and `list` turn into an empty answer.
 */
export const createArtifactStore = (
  services: Services,
  call: Call,
): ArtifactStore => {
  const lease = services.use(RuntimeLeaseV1, call.scope);

  const run = async <T>(task: (sandbox: Sandbox) => Promise<T>): Promise<T> => {
    const outcome = await lease.withLease(
      task as (sandbox: Sandbox) => Promise<unknown>,
      call,
    );

    if (outcome.status !== 'ready') throw leaseUnavailable(outcome.status);

    return outcome.value as T;
  };

  const directoryOf = (sandbox: Sandbox): string =>
    `${withoutTrailingSlash(sandbox.root)}/${artifactsDirectory}`;

  /**
   * The directory of one artifact. The id grammar and the entry path rule are
   * what keep every path below inside `.doric/artifacts/`; both are checked
   * here once more, whatever the caller validated.
   */
  const artifactDir = (sandbox: Sandbox, artifactId: string): string => {
    if (!artifactIdPattern.test(artifactId)) {
      throw new ContractError(
        'invalid_input',
        `"${artifactId}" is not an artifact id.`,
        { artifactId },
      );
    }

    return `${directoryOf(sandbox)}/${artifactId}`;
  };

  const entryPath = (base: string, path: string): string => {
    if (!isArtifactEntryPath(path)) {
      throw new ContractError(
        'invalid_input',
        `Entry path "${path}" leaves the artifact's directory.`,
        { path },
      );
    }

    return `${base}/${path}`;
  };

  const getFile = async (
    sandbox: Sandbox,
    path: string,
  ): Promise<Uint8Array | undefined> => {
    try {
      return await sandbox.getFile(path);
    } catch {
      return undefined;
    }
  };

  const loadIn = async (
    sandbox: Sandbox,
    artifactId: string,
  ): Promise<LoadedArtifact> => {
    const bytes = await getFile(
      sandbox,
      `${artifactDir(sandbox, artifactId)}/artifact.json`,
    );

    if (bytes === undefined) return { status: 'missing' };

    try {
      const parsed = storedArtifactSchema.safeParse(
        JSON.parse(Buffer.from(bytes).toString('utf8')),
      );

      // A manifest of a future layout, or one an editor broke, makes that
      // one artifact unavailable — never the Project's whole list.
      if (!parsed.success || parsed.data.artifactId !== artifactId) {
        return { status: 'unreadable' };
      }

      return { status: 'ok', artifact: storedOf(parsed.data) };
    } catch {
      return { status: 'unreadable' };
    }
  };

  /**
   * `.doric/` is app state in the user's Project: before the first write under
   * it, the store makes sure `.doric/.gitignore` exists with `*` — versioning
   * an artifact is a choice, not the default.
   */
  const ensureIgnored = async (sandbox: Sandbox): Promise<void> => {
    const ignore = `${withoutTrailingSlash(sandbox.root)}/${dotDoricGitignore}`;

    if ((await getFile(sandbox, ignore)) !== undefined) return;

    await sandbox.writeFile(ignore, `${DOT_DORIC_IGNORE}\n`);
  };

  return {
    load: (artifactId) => run((sandbox) => loadIn(sandbox, artifactId)),
    list: () =>
      run(async (sandbox) => {
        const result = await sandbox.exec({
          cmd: ['ls', '-1', '--', directoryOf(sandbox)],
        });

        if (result.exitCode !== 0) return [];

        const ids = result.stdout
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => artifactIdPattern.test(line));
        const loaded = await Promise.all(ids.map((id) => loadIn(sandbox, id)));

        return loaded.flatMap((entry) =>
          entry.status === 'ok' ? [entry.artifact] : [],
        );
      }),
    readEntry: (artifactId, path, sha256, revisions) =>
      run(async (sandbox) => {
        const base = artifactDir(sandbox, artifactId);
        const candidates = [
          ...revisions.map((revision) =>
            entryPath(`${base}/${revision}`, path),
          ),
          // The first layout kept every revision's entries at the root.
          entryPath(base, path),
        ];

        for (const candidate of candidates) {
          const bytes = await getFile(sandbox, candidate);

          if (bytes !== undefined && sha256Of(bytes) === sha256) return bytes;
        }

        return undefined;
      }),
    writeRevision: (artifactId, revision, files) =>
      run(async (sandbox) => {
        const base = `${artifactDir(sandbox, artifactId)}/${revision}`;

        await ensureIgnored(sandbox);

        for (const file of files) {
          await sandbox.putFile(entryPath(base, file.path), file.bytes);
        }
      }),
    removeRevision: (artifactId, revision) =>
      run(async (sandbox) => {
        await sandbox.exec({
          cmd: [
            'rm',
            '-rf',
            '--',
            `${artifactDir(sandbox, artifactId)}/${revision}`,
          ],
        });
      }),
    writeManifest: (artifactId, artifact) =>
      run(async (sandbox) => {
        const base = artifactDir(sandbox, artifactId);

        if (artifact === undefined) {
          await sandbox.exec({ cmd: ['rm', '-rf', '--', base] });
          return;
        }

        await ensureIgnored(sandbox);
        await sandbox.writeFile(
          `${base}/artifact.json`,
          `${JSON.stringify(artifact, null, 2)}\n`,
        );
      }),
  };
};
