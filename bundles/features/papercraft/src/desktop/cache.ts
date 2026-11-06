// The verified cache of the modules papercraft fences load (D14,
// `papercraft.cache/v1`): every entry a window hands over from the host's
// `papercraft.programs/v1.read` lands in `<root>/<dir>/<file>` only once its
// SHA-256 equals the entry's. Writes are staged on the same volume and
// renamed into place, so no partial file is ever served — the machine of the
// artifacts bundle's cache (`bundles/features/artifacts/src/desktop/cache.ts`).
//
// Once per desktop app session (one cache object) the first `ensure` cuts the
// root back — above 256 MiB, whole `<dir>/` directories oldest first, down to
// at most 128 MiB — and every `ensure` awaits that cut-back before it writes.
// A directory `ensure` writes or keeps gets a fresh modification time, so the
// modules in use are never among the oldest.

import { createHash, randomBytes } from 'node:crypto';
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
} from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

import type {
  ModuleCacheEnsureResult,
  ModuleCacheEntry,
} from '../contracts/cache.js';

const MiB = 1024 * 1024;

/** Above this the session's first `ensure` cuts the cache back. */
export const CUT_ABOVE = 256 * MiB;

/** What the cut-back leaves at most. */
export const CUT_TO = 128 * MiB;

/** A module directory: `ModuleRef.dir`, a SHA-256 in lowercase hex. */
const DIR_PATTERN = /^[0-9a-f]{64}$/u;

const sha256 = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The segments of one `<dir>/<file>` path; undefined when the first is not a
 * module directory, there is no file, or a segment is empty, `.`, `..`, or
 * carries NUL or a backslash.
 */
const segmentsOf = (path: string): string[] | undefined => {
  const segments = path.split('/');

  if (segments.length < 2 || !DIR_PATTERN.test(segments[0] ?? ''))
    return undefined;

  for (const part of segments) {
    if (
      part === '' ||
      part === '.' ||
      part === '..' ||
      part.includes('\0') ||
      part.includes('\\')
    )
      return undefined;
  }

  return segments;
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

/** The bytes the files under `path` hold. */
const sizeOf = async (path: string): Promise<number> => {
  let total = 0;

  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);

    total += entry.isDirectory()
      ? await sizeOf(child)
      : (await stat(child)).size;
  }

  return total;
};

/** The modules cache of one desktop app session. */
export class ModulesCache {
  readonly #root: string;
  readonly #staging: string;
  #cut: Promise<void> | undefined;

  constructor(root: string, staging: string) {
    this.#root = root;
    this.#staging = staging;
  }

  /** The session's cut-back, run at the first call and awaited by every one. */
  #cutBack(): Promise<void> {
    this.#cut ??= this.#cutOnce().catch(() => undefined);

    return this.#cut;
  }

  async #cutOnce(): Promise<void> {
    const entries = await readdir(this.#root, { withFileTypes: true }).catch(
      () => [],
    );

    const dirs = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && DIR_PATTERN.test(entry.name))
        .map(async (entry) => {
          const path = join(this.#root, entry.name);

          return {
            path,
            mtime: (await stat(path)).mtimeMs,
            size: await sizeOf(path),
          };
        }),
    );
    let total = dirs.reduce((sum, dir) => sum + dir.size, 0);

    if (total <= CUT_ABOVE) return;

    for (const dir of dirs.sort((a, b) => a.mtime - b.mtime)) {
      if (total <= CUT_TO) break;
      await rm(dir.path, { recursive: true, force: true });
      total -= dir.size;
    }
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
   * Ensures every entry is present with its declared hash: a cached file
   * that matches is kept, every other entry's bytes are verified against the
   * declared SHA-256 and only then written. Each directory written or kept
   * gets a fresh modification time.
   */
  async ensure(input: {
    readonly entries: readonly ModuleCacheEntry[];
  }): Promise<ModuleCacheEnsureResult> {
    await this.#cutBack();

    const written: string[] = [];
    const kept: string[] = [];
    const failed: { path: string; message: string }[] = [];
    const touched = new Set<string>();

    for (const entry of input.entries) {
      const segments = segmentsOf(entry.path);
      const target =
        segments === undefined ? undefined : insideRoot(this.#root, segments);

      if (segments === undefined || target === undefined) {
        failed.push({
          path: entry.path,
          message: `module entry is not <dir>/<file> of this cache: ${entry.path}`,
        });
        continue;
      }

      const bytes = new Uint8Array(Buffer.from(entry.base64, 'base64'));

      if (sha256(bytes) !== entry.sha256) {
        failed.push({
          path: entry.path,
          message: `module entry hash mismatch: ${entry.path}`,
        });
        continue;
      }

      const dir = join(this.#root, segments[0] as string);

      if (await this.#matches(target, entry.sha256)) {
        kept.push(entry.path);
        touched.add(dir);
        continue;
      }

      try {
        await this.#install(target, bytes);
        written.push(entry.path);
        touched.add(dir);
      } catch (error) {
        failed.push({
          path: entry.path,
          message: `module entry write failed: ${entry.path}: ${messageOf(error)}`,
        });
      }
    }

    const now = new Date();

    for (const dir of touched)
      await utimes(dir, now, now).catch(() => undefined);

    return { written, kept, failed };
  }
}
