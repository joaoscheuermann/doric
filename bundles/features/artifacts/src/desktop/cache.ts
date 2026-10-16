// The verified cache of an artifact revision's compiled entries
// (`docs/architecture/bundles/artifacts.md`, stage 2): every entry a window
// hands over from `artifacts/v1.read` lands in
// `<root>/<artifactId>@<revision>/<path>` only once its SHA-256 equals the
// entry's. Writes are staged on the same volume and renamed into place, so no
// partial file is ever served — the same machine as the platform's bundle
// cache (`app/desktop/doric/src/platform/catalog/artifacts.ts`).

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

import {
  type ArtifactCacheEnsureInput,
  type ArtifactCacheEnsureResult,
  type ArtifactCacheEntry,
  type ArtifactCacheEntryFailure,
  type ArtifactCacheEntryFailureReason,
  artifactIdPattern,
} from '../contracts/index.js';

// The wire types this cache implements live with the bundle's other contracts
// (`artifacts.cache/v1` in `src/contracts/index.ts`); the names below are the
// ones this implementation grew with, kept as aliases.
export type RevisionEntry = ArtifactCacheEntry;
export type RevisionEntryFailureReason = ArtifactCacheEntryFailureReason;
export type RevisionEntryFailure = ArtifactCacheEntryFailure;
export type RevisionInput = ArtifactCacheEnsureInput;
export type EnsureRevisionResult = ArtifactCacheEnsureResult;

/**
 * One compiled entry of a revision, the wire shape `artifacts/v1.read`
 * returns: `{ path, sha256, base64 }`, in the mold of
 * `doric.catalog/v1.artifact`.
 */
export type { ArtifactCacheEntry } from '../contracts/index.js';

const sha256 = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const decodeBase64 = (base64: string): Uint8Array =>
  new Uint8Array(Buffer.from(base64, 'base64'));

/**
 * The path segments of one revision-relative entry path; undefined when one is
 * empty, `.`, `..`, or carries NUL, a slash or a backslash once split.
 */
const segmentsOf = (path: string): string[] | undefined => {
  const segments: string[] = [];

  for (const part of path.split('/')) {
    if (
      part === '' ||
      part === '.' ||
      part === '..' ||
      part.includes('\0') ||
      part.includes('\\')
    ) {
      return undefined;
    }

    segments.push(part);
  }

  return segments.length === 0 ? undefined : segments;
};

/** `root` joined with the segments, or undefined when it leaves `root`. */
const insideRoot = (
  root: string,
  segments: readonly string[],
): string | undefined => {
  const base = resolve(root);
  const target = resolve(base, ...segments);
  const rel = relative(base, target);

  return rel === '' || rel.startsWith('..') || rel.startsWith(sep)
    ? undefined
    : target;
};

/** The directory of one revision's verified files. */
export const revisionFolderOf = (artifactId: string, revision: number) =>
  `${artifactId}@${revision}`;

/**
 * The verified artifact revisions. The desktop platform places this bundle's
 * `doric.cache/v1` directory at `userData/artifacts/`, the tree the
 * `doric://app/artifacts/<artifactId>@<revision>/…` route serves, so only
 * entries that passed the hash check are ever reachable from a window.
 */
export class ArtifactRevisionsCache {
  readonly #root: string;
  readonly #staging: string;

  constructor(root: string, staging: string) {
    this.#root = root;
    this.#staging = staging;
  }

  get root(): string {
    return this.#root;
  }

  /**
   * The directory of one revision's verified files, or undefined when the
   * identity is not an artifact id or a positive revision — the folder name
   * is built from both, so neither may carry a path of its own.
   */
  directoryOf(artifactId: string, revision: number): string | undefined {
    if (
      !artifactIdPattern.test(artifactId) ||
      !Number.isInteger(revision) ||
      revision <= 0
    ) {
      return undefined;
    }

    return insideRoot(this.#root, [revisionFolderOf(artifactId, revision)]);
  }

  /**
   * A file of one revision, or undefined when the identity or the path would
   * leave the revision's directory — and with it the cache root.
   */
  pathOf(
    artifactId: string,
    revision: number,
    path: string,
  ): string | undefined {
    const directory = this.directoryOf(artifactId, revision);
    const segments = segmentsOf(path);

    if (directory === undefined || segments === undefined) return undefined;

    // The directory is inside the root, and the target inside the directory.
    return insideRoot(directory, segments);
  }

  async #matches(path: string, expected: string): Promise<boolean> {
    try {
      return sha256(await readFile(path)) === expected;
    } catch {
      return false;
    }
  }

  async #install(target: string, bytes: Uint8Array): Promise<void> {
    await mkdir(this.#staging, { recursive: true });

    const staged = join(this.#staging, randomBytes(8).toString('hex'));
    const handle = await open(staged, 'w');

    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      await mkdir(dirname(target), { recursive: true });
      await rename(staged, target);
    } catch (error) {
      await rm(staged, { force: true });
      throw error;
    }
  }

  /**
   * Ensures every entry of one revision is present with its declared hash: a
   * cached file that matches is kept, every other entry's bytes are verified
   * against the declared SHA-256 and only then written, so a tampered cache
   * file is replaced and bytes that do not match never reach the disk.
   */
  async ensure(input: RevisionInput): Promise<EnsureRevisionResult> {
    let kept = 0;
    let written = 0;
    const failed: RevisionEntryFailure[] = [];

    // An identity that is not one names no directory of this cache: every
    // entry is refused before a byte is decoded.
    if (this.directoryOf(input.artifactId, input.revision) === undefined) {
      return {
        kept,
        written,
        failed: input.entries.map((entry) => ({
          path: entry.path,
          reason: 'invalid_path',
          message: `artifact revision is not one of this cache: ${input.artifactId}@${input.revision}`,
        })),
      };
    }

    for (const entry of input.entries) {
      const target = this.pathOf(input.artifactId, input.revision, entry.path);

      if (target === undefined) {
        failed.push({
          path: entry.path,
          reason: 'invalid_path',
          message: `artifact entry leaves the revision directory: ${entry.path}`,
        });
        continue;
      }

      const bytes = decodeBase64(entry.base64);

      if (sha256(bytes) !== entry.sha256) {
        failed.push({
          path: entry.path,
          reason: 'hash_mismatch',
          message: `artifact entry hash mismatch: ${entry.path}`,
        });
        continue;
      }

      if (await this.#matches(target, entry.sha256)) {
        kept += 1;
        continue;
      }

      try {
        await this.#install(target, bytes);
        written += 1;
      } catch (error) {
        failed.push({
          path: entry.path,
          reason: 'write_failed',
          message: `artifact entry write failed: ${entry.path}: ${messageOf(error)}`,
        });
      }
    }

    return { kept, written, failed };
  }
}
