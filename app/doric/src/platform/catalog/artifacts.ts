// The verified artifact cache (section 11.4): every distributed file of a
// bundle lands in `userData/bundles/<id>@<version>/<path>` only once its
// SHA-256 equals the catalog's. Downloads are staged on the same volume and
// renamed into place, so no partial file is ever served.

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { DistributionBundle } from 'bundle/runtime';

import { insideRoot, type ServedBundles } from '../protocol/handler';

export interface ArtifactProgress {
  readonly done: number;
  readonly total: number;
  /** Whether the current file needed a download. */
  readonly downloading: boolean;
}

export interface ArtifactFailure {
  readonly bundleId: string;
  readonly path: string;
  readonly reason: 'hash_mismatch' | 'download_failed';
  readonly message: string;
}

export interface EnsureResult {
  readonly verified: number;
  readonly downloaded: number;
  readonly failed: readonly ArtifactFailure[];
}

export type ArtifactFetch = (sha256: string) => Promise<Uint8Array>;

const sha256 = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

const folderOf = (bundle: { readonly id: string; readonly version: string }) =>
  `${bundle.id}@${bundle.version}`;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class ArtifactCache implements ServedBundles {
  readonly #root: string;
  readonly #staging: string;
  /** generation → `<id>@<version>` → listed paths. */
  readonly #retained = new Map<number, Map<string, ReadonlySet<string>>>();

  constructor(root: string, staging: string) {
    this.#root = root;
    this.#staging = staging;
  }

  get root(): string {
    return this.#root;
  }

  /** The directory of one bundle's verified files. */
  directoryOf(bundle: {
    readonly id: string;
    readonly version: string;
  }): string {
    return join(this.#root, folderOf(bundle));
  }

  /** A path under a bundle directory, or undefined when it leaves it. */
  pathOf(
    bundle: { readonly id: string; readonly version: string },
    path: string,
  ): string | undefined {
    return insideRoot(this.directoryOf(bundle), path.split('/'));
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
   * Ensures every listed file of the given bundles is present with the
   * catalog hash: a cached file that matches is kept, any other is fetched by
   * hash and verified before it is written.
   */
  async ensure(
    bundles: readonly DistributionBundle[],
    fetch: ArtifactFetch,
    progress: (progress: ArtifactProgress) => void = () => undefined,
  ): Promise<EnsureResult> {
    const total = bundles.reduce((sum, bundle) => sum + bundle.files.length, 0);
    let done = 0;
    let verified = 0;
    let downloaded = 0;
    const failed: ArtifactFailure[] = [];

    for (const bundle of bundles) {
      for (const file of bundle.files) {
        const target = this.pathOf(bundle, file.path);

        if (target === undefined) {
          failed.push({
            bundleId: bundle.id,
            path: file.path,
            reason: 'download_failed',
            message: `artifact path leaves the bundle directory: ${file.path}`,
          });
          done += 1;
          continue;
        }

        if (await this.#matches(target, file.sha256)) {
          verified += 1;
          done += 1;
          progress({ done, total, downloading: false });
          continue;
        }

        progress({ done, total, downloading: true });

        let bytes: Uint8Array;

        try {
          bytes = await fetch(file.sha256);
        } catch (error) {
          failed.push({
            bundleId: bundle.id,
            path: file.path,
            reason: 'download_failed',
            message: `artifact download failed: ${file.path}: ${messageOf(error)}`,
          });
          done += 1;
          continue;
        }

        if (sha256(bytes) !== file.sha256) {
          failed.push({
            bundleId: bundle.id,
            path: file.path,
            reason: 'hash_mismatch',
            message: `artifact hash mismatch: ${file.path}`,
          });
          done += 1;
          continue;
        }

        try {
          await this.#install(target, bytes);
          downloaded += 1;
        } catch (error) {
          failed.push({
            bundleId: bundle.id,
            path: file.path,
            reason: 'download_failed',
            message: `artifact write failed: ${file.path}: ${messageOf(error)}`,
          });
        }

        done += 1;
        progress({ done, total, downloading: true });
      }
    }

    return { verified, downloaded, failed };
  }

  /** Lets the protocol serve these bundles' listed files for a generation. */
  retain(generation: number, bundles: readonly DistributionBundle[]): void {
    this.#retained.set(
      generation,
      new Map(
        bundles.map((bundle) => [
          folderOf(bundle),
          new Set(bundle.files.map((file) => file.path)),
        ]),
      ),
    );
  }

  release(generation: number): void {
    this.#retained.delete(generation);
  }

  retained(): readonly number[] {
    return [...this.#retained.keys()];
  }

  file(id: string, version: string, path: string): string | undefined {
    const folder = `${id}@${version}`;

    for (const bundles of this.#retained.values()) {
      if (bundles.get(folder)?.has(path) === true) {
        return this.pathOf({ id, version }, path);
      }
    }

    return undefined;
  }

  /**
   * Deletes `<id>@<version>` directories that no retained generation and no
   * kept bundle (the catalog snapshot, the last good core) references, and
   * the staging directory.
   */
  async collect(
    keep: readonly { readonly id: string; readonly version: string }[] = [],
  ): Promise<void> {
    const referenced = new Set<string>(keep.map(folderOf));

    for (const bundles of this.#retained.values()) {
      for (const folder of bundles.keys()) {
        referenced.add(folder);
      }
    }

    let entries: string[];

    try {
      entries = await readdir(this.#root);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry === '.tmp') {
        await rm(join(this.#root, entry), { recursive: true, force: true });
        continue;
      }

      if (!referenced.has(entry)) {
        await rm(join(this.#root, entry), { recursive: true, force: true });
      }
    }
  }
}
