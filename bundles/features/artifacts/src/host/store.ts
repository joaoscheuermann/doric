// Where the registry keeps its work copy: `/workspace/.doric/artifacts/
// <artifactId>/artifact.json` plus the payload files a revision's entries name,
// reached through the Project's sandbox lease (`runtime.lease/v1`) exactly as
// `files` reaches the workspace. The directory belongs to the app, not to the
// user's code — it is born Git-ignored (`.doric/.gitignore`, `*`) — and the
// log stays the durable truth: this manifest is regenerable and its revisions
// are never rewritten.

import { createHash } from 'node:crypto';

import type { Call, Services } from 'bundle/contracts';
import { RuntimeLeaseV1 } from 'runtime/contracts';
import { z } from 'zod';

import {
  type ArtifactSource,
  type ArtifactTarget,
  artifactEntrySchema,
  artifactSourceSchema,
  artifactTargetSchema,
} from '../contracts/index.js';

/** The directory of a Project's artifacts, relative to its workspace root. */
export const artifactsDirectory = '.doric/artifacts';

/** The Git ignore that keeps the app's directory out of the user's code. */
export const dotDoricGitignore = '.doric/.gitignore';

/** What `.doric/.gitignore` says: the whole directory is app state. */
export const DOT_DORIC_IGNORE = '*';

/** The sha256 of a payload's bytes, as `git`'s object hashes are written. */
export const sha256Of = (content: string): string =>
  createHash('sha256').update(content, 'utf8').digest('hex');

/** One revision of the stored manifest; earlier revisions are never rewritten. */
export interface StoredArtifactRevision {
  readonly revision: number;
  readonly targets: readonly ArtifactTarget[];
  /** The entries of this revision: their paths and hashes, never the bytes. */
  readonly entries: readonly {
    readonly path: string;
    readonly sha256: string;
  }[];
  readonly source?: ArtifactSource;
  readonly path?: string;
  readonly entry?: string;
  readonly notes?: string;
  readonly changeNote?: string;
  readonly createdAt: string;
}

/**
 * `artifact.json`: the artifact's identity and the whole list of its revisions
 * — each with its anchors and entries. `threadId` and `promptId` are the
 * provenance of the creation, so `list` can answer a Thread's own artifacts.
 */
export interface StoredArtifact {
  readonly manifestVersion: 1;
  readonly artifactId: string;
  readonly kind: string;
  readonly title: string;
  readonly state: 'open' | 'approved';
  readonly approvedRevision?: number;
  readonly createdAt: string;
  readonly createdBy?: string;
  readonly threadId?: string;
  readonly promptId?: string;
  readonly revisions: readonly StoredArtifactRevision[];
}

/** The work copy of one Project's artifacts. */
export interface ArtifactStore {
  read(artifactId: string): Promise<StoredArtifact | undefined>;
  write(artifact: StoredArtifact): Promise<void>;
  list(): Promise<readonly StoredArtifact[]>;
  /**
   * The bytes of one entry, when the work copy holds them: the entry is
   * artifact-relative, and `read` serves what is in the directory.
   */
  readEntry(artifactId: string, path: string): Promise<string | undefined>;
  /** Writes one entry's bytes into the artifact's directory. */
  writeEntry(artifactId: string, path: string, content: string): Promise<void>;
}

const storedEntrySchema = artifactEntrySchema;

const storedArtifactSchema = z.looseObject({
  manifestVersion: z.literal(1),
  artifactId: z.string(),
  kind: z.string(),
  title: z.string(),
  state: z.enum(['open', 'approved']),
  approvedRevision: z.number().int().optional(),
  createdAt: z.string(),
  createdBy: z.string().optional(),
  threadId: z.string().optional(),
  promptId: z.string().optional(),
  revisions: z.array(
    z.looseObject({
      revision: z.number().int(),
      targets: z.array(artifactTargetSchema),
      entries: z.array(storedEntrySchema),
      source: artifactSourceSchema.optional(),
      path: z.string().optional(),
      entry: z.string().optional(),
      notes: z.string().optional(),
      changeNote: z.string().optional(),
      createdAt: z.string(),
    }),
  ),
});

const withoutTrailingSlash = (value: string): string =>
  value.replace(/\/+$/u, '');

/**
 * The artifact store of the Project `call` is scoped to. Every operation runs
 * on that Project's lease; a Project without one rejects with the lease's own
 * error, as `files/v1` does.
 */
export const createArtifactStore = (
  services: Services,
  call: Call,
): ArtifactStore => {
  const lease = services.use(RuntimeLeaseV1, call.scope);

  const directory = async (): Promise<string> => {
    const { root } = await lease.describe(call);

    return `${withoutTrailingSlash(root)}/${artifactsDirectory}`;
  };

  const artifactDir = async (artifactId: string): Promise<string> =>
    `${await directory()}/${artifactId}`;

  const manifestPath = async (artifactId: string): Promise<string> =>
    `${await artifactDir(artifactId)}/artifact.json`;

  const read = async (
    artifactId: string,
  ): Promise<StoredArtifact | undefined> => {
    const result = await lease.exec(
      { cmd: ['cat', '--', await manifestPath(artifactId)] },
      call,
    );

    if (result.exitCode !== 0) return undefined;

    return storedArtifactSchema.parse(
      JSON.parse(result.stdout),
    ) as StoredArtifact;
  };

  /**
   * `.doric/` is app state in the user's Project: before the first write under
   * it, the store makes sure `.doric/.gitignore` exists with `*` — versioning
   * an artifact is a choice, not the default.
   */
  const ensureIgnored = async (): Promise<void> => {
    const { root } = await lease.describe(call);
    const ignore = `${withoutTrailingSlash(root)}/${dotDoricGitignore}`;
    const existing = await lease.exec({ cmd: ['cat', '--', ignore] }, call);

    if (existing.exitCode === 0) return;

    await lease.writeFile(ignore, `${DOT_DORIC_IGNORE}\n`, call);
  };

  const write = async (artifact: StoredArtifact): Promise<void> => {
    await ensureIgnored();
    await lease.writeFile(
      await manifestPath(artifact.artifactId),
      `${JSON.stringify(artifact, null, 2)}\n`,
      call,
    );
  };

  const list = async (): Promise<readonly StoredArtifact[]> => {
    const result = await lease.exec(
      { cmd: ['ls', '-1', await directory()] },
      call,
    );

    if (result.exitCode !== 0) return [];

    const ids = result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');

    const stored = await Promise.all(ids.map((id) => read(id)));

    return stored.filter((artifact) => artifact !== undefined);
  };

  const readEntry = async (
    artifactId: string,
    path: string,
  ): Promise<string | undefined> => {
    const result = await lease.exec(
      { cmd: ['cat', '--', `${await artifactDir(artifactId)}/${path}`] },
      call,
    );

    return result.exitCode === 0 ? result.stdout : undefined;
  };

  const writeEntry = async (
    artifactId: string,
    path: string,
    content: string,
  ): Promise<void> => {
    await ensureIgnored();
    await lease.writeFile(
      `${await artifactDir(artifactId)}/${path}`,
      content,
      call,
    );
  };

  return { read, write, list, readEntry, writeEntry };
};
