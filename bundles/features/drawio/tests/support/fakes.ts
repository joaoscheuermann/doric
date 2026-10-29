// In-memory doubles of the boundaries the `drawio` host part crosses: the
// leased sandbox (filesystem), the lease and the workspace of the runtime, the
// artifacts registry and the comments log. Each records what it was asked to
// write, so a test can say "nothing was published" without counting calls.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import type {
  ArtifactEntry,
  ArtifactFile,
  ArtifactRecord,
  ArtifactRevisionRead,
  Comment,
  LeasedSandbox,
  LeaseOutcome,
} from '../../src/contracts/index.js';
import { servicesFor } from './services.js';

export const ROOT = '/workspace';
export const CWD = '/workspace/app';

export const sha256 = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');

export const base64Of = (text: string): string =>
  Buffer.from(text, 'utf8').toString('base64');

export const textOf = (base64: string): string =>
  Buffer.from(base64, 'base64').toString('utf8');

/* Sandbox -------------------------------------------------------------------- */

export interface FakeSandbox extends LeasedSandbox {
  /** The files, by absolute path. */
  readonly files: Map<string, Uint8Array>;
  /** The directories, by absolute path. */
  readonly dirs: Set<string>;
  /** Every `writeFile`, in order. */
  readonly writes: { readonly path: string; readonly content: string }[];
  /** Every `getFile`, in order. */
  readonly reads: string[];
  /** The symbolic links, absolute path → target. */
  readonly links: Map<string, string>;
  /** The special entries (fifos), by absolute path. */
  readonly specials: Set<string>;
  /** Every `exec` command, in order, overridden calls included. */
  readonly execs: string[][];
  /** Whether `path` is a file, a directory, a link or a special entry. */
  exists(path: string): boolean;
  /** Whether `path` is a directory (not followed through a link). */
  isDir(path: string): boolean;
  /** Whether any file, directory, link or special entry lies under `path`. */
  hasChildren(path: string): boolean;
}

export type FakeExecAnswer = { readonly exitCode: number | null } | Error;

export interface FakeSandboxOptions {
  /** Symbolic links, absolute path → target. */
  readonly links?: Record<string, string>;
  /** Special entries (fifos), by absolute path. */
  readonly specials?: readonly string[];
  /**
   * Overrides one `exec` call: an answer is returned, an `Error` makes the
   * call reject, and `undefined` falls through to the default behavior.
   */
  readonly exec?: (cmd: readonly string[]) => FakeExecAnswer | undefined;
  /** `writeFile` on these absolute paths throws `Error('disk full')`. */
  readonly failWrites?: readonly string[];
}

const MKDIR_FAILED = 'Sandbox command failed with exit code 1';

/** `/a/b/c` → `['/a', '/a/b']`. */
const parentsOf = (path: string): string[] => {
  const parts = path.split('/').filter((part) => part !== '');

  return parts
    .slice(0, -1)
    .map((_, index) => `/${parts.slice(0, index + 1).join('/')}`);
};

const isUnder = (path: string, folder: string): boolean =>
  path.startsWith(folder.endsWith('/') ? folder : `${folder}/`);

export const fakeSandbox = (
  files: Record<string, string | Uint8Array> = {},
  dirs: readonly string[] = [],
  options: FakeSandboxOptions = {},
): FakeSandbox => {
  const map = new Map<string, Uint8Array>(
    Object.entries(files).map(([path, content]) => [
      path,
      typeof content === 'string' ? Buffer.from(content, 'utf8') : content,
    ]),
  );
  const dirSet = new Set([ROOT, CWD, ...dirs]);
  const links = new Map(Object.entries(options.links ?? {}));
  const specials = new Set(options.specials ?? []);
  const failWrites = new Set(options.failWrites ?? []);
  const writes: { path: string; content: string }[] = [];
  const reads: string[] = [];
  const execs: string[][] = [];

  /** What `path` is after following at most one link; `undefined` when nothing. */
  const resolve = (path: string): 'file' | 'dir' | undefined => {
    const target = links.get(path) ?? path;

    if (map.has(target)) {
      return 'file';
    }

    return dirSet.has(target) ? 'dir' : undefined;
  };

  const removeUnder = (folder: string): void => {
    for (const store of [map, links]) {
      for (const key of [...store.keys()]) {
        if (isUnder(key, folder)) {
          store.delete(key);
        }
      }
    }

    for (const store of [dirSet, specials]) {
      for (const key of [...store]) {
        if (isUnder(key, folder)) {
          store.delete(key);
        }
      }
    }
  };

  const testExit = (flag: string | undefined, path: string): number => {
    switch (flag) {
      case '-h':
        return links.has(path) ? 0 : 1;
      case '-d':
        return resolve(path) === 'dir' ? 0 : 1;
      case '-f':
        return resolve(path) === 'file' ? 0 : 1;
      case '-e':
        return resolve(path) !== undefined || specials.has(path) ? 0 : 1;
      default:
        return 2;
    }
  };

  return {
    root: ROOT,
    files: map,
    dirs: dirSet,
    writes,
    reads,
    links,
    specials,
    execs,
    exists: (path) =>
      map.has(path) ||
      dirSet.has(path) ||
      links.has(path) ||
      specials.has(path),
    isDir: (path) => dirSet.has(path),
    hasChildren: (path) =>
      [...map.keys(), ...dirSet, ...links.keys(), ...specials].some((key) =>
        isUnder(key, path),
      ),
    getFile: async (path) => {
      reads.push(path);

      if (dirSet.has(path)) {
        throw new Error(
          `EISDIR: illegal operation on a directory, read '${path}'`,
        );
      }

      const bytes = map.get(path);

      if (bytes === undefined) {
        throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      }

      return bytes;
    },
    writeFile: async (path, content) => {
      if (failWrites.has(path)) {
        throw new Error('disk full');
      }

      // `mkdir -p` of the parents: a file, a special entry or a link that does
      // not lead to a directory stops it.
      const parents = parentsOf(path);

      for (const parent of parents) {
        const blocked =
          map.has(parent) ||
          specials.has(parent) ||
          (links.has(parent) && resolve(parent) !== 'dir');

        if (blocked) {
          throw new Error(MKDIR_FAILED);
        }
      }

      for (const parent of parents) {
        if (!links.has(parent)) {
          dirSet.add(parent);
        }
      }

      // Docker's `putArchive` replaces whatever entry is at the path.
      if (dirSet.has(path)) {
        dirSet.delete(path);
        removeUnder(path);
      }

      links.delete(path);
      specials.delete(path);
      writes.push({ path, content });
      map.set(path, Buffer.from(content, 'utf8'));
    },
    exec: async ({ cmd }) => {
      execs.push([...cmd]);

      const override = options.exec?.(cmd);

      if (override instanceof Error) {
        throw override;
      }

      if (override !== undefined) {
        return override;
      }

      const [program, flag, path = ''] = cmd;

      if (program === 'rm' && flag === '-f' && cmd[2] === '--') {
        const target = cmd[3] ?? '';

        map.delete(target);
        links.delete(target);
        specials.delete(target);

        return { exitCode: 0 };
      }

      if (program !== 'test') {
        return { exitCode: 127 };
      }

      return { exitCode: testExit(flag, path) };
    },
  };
};

/* Lease and workspace -------------------------------------------------------- */

export type LeaseStatus = LeaseOutcome<unknown>['status'];

export const fakeLease = (
  sandbox: LeasedSandbox,
  status: LeaseStatus = 'ready',
) => ({
  withLease: async <T>(
    task: (sandbox: LeasedSandbox) => Promise<T>,
  ): Promise<LeaseOutcome<T>> =>
    status === 'ready'
      ? { status: 'ready', value: await task(sandbox) }
      : { status },
});

export const fakeWorkspace = () => ({ cwd: async () => CWD });

/* Artifacts ------------------------------------------------------------------ */

/** One stored revision of a seeded artifact. */
export interface SeedRevision {
  /** The stored `diagram.drawio` text; absent: the revision has no such entry. */
  readonly xml?: string;
  readonly changeNote?: string;
  readonly path?: string;
  /** The work copy no longer holds the bytes: `read` serves no `base64`. */
  readonly gone?: boolean;
}

export interface SeedArtifact {
  readonly artifactId: string;
  readonly kind?: string;
  readonly title?: string;
  readonly notes?: string;
  readonly revisions: readonly SeedRevision[];
}

export interface ArtifactWrite {
  readonly method: 'create' | 'revise';
  readonly input: {
    readonly artifactId?: string;
    readonly kind?: string;
    readonly title?: string;
    readonly path?: string;
    readonly notes?: string;
    readonly changeNote?: string;
    readonly entries: readonly ArtifactEntry[];
    readonly files: readonly ArtifactFile[];
  } & Record<string, unknown>;
}

interface Stored {
  readonly kind: string;
  readonly title: string;
  readonly notes?: string;
  readonly revisions: {
    readonly entries: readonly ArtifactEntry[];
    readonly bytes: Map<string, string | undefined>;
    readonly path?: string;
    readonly changeNote?: string;
  }[];
}

export const fakeArtifacts = (seed: readonly SeedArtifact[] = []) => {
  const store = new Map<string, Stored>();
  const writes: ArtifactWrite[] = [];
  /** The ids every `read` and `revisions` asked for, in order. */
  const reads: string[] = [];

  for (const artifact of seed) {
    store.set(artifact.artifactId, {
      kind: artifact.kind ?? 'diagram',
      title: artifact.title ?? 'Fluxo',
      ...(artifact.notes === undefined ? {} : { notes: artifact.notes }),
      revisions: artifact.revisions.map((revision) => ({
        entries:
          revision.xml === undefined
            ? [{ path: 'other.txt', sha256: sha256('other') }]
            : [{ path: 'diagram.drawio', sha256: sha256(revision.xml) }],
        bytes: new Map(
          revision.xml === undefined
            ? [['other.txt', revision.gone ? undefined : base64Of('other')]]
            : [
                [
                  'diagram.drawio',
                  revision.gone ? undefined : base64Of(revision.xml),
                ],
              ],
        ),
        ...(revision.path === undefined ? {} : { path: revision.path }),
        ...(revision.changeNote === undefined
          ? {}
          : { changeNote: revision.changeNote }),
      })),
    });
  }

  const recordOf = (artifactId: string, index: number): ArtifactRecord => {
    const stored = store.get(artifactId);
    const revision = stored?.revisions[index];

    assert.ok(stored !== undefined && revision !== undefined);

    return {
      artifactId,
      kind: stored.kind,
      title: stored.title,
      revision: index + 1,
      revisions: stored.revisions.length,
      entries: revision.entries,
      ...(revision.path === undefined ? {} : { path: revision.path }),
      ...(stored.notes === undefined ? {} : { notes: stored.notes }),
      ...(revision.changeNote === undefined
        ? {}
        : { changeNote: revision.changeNote }),
      state: 'open',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
  };

  const bytesOf = (files: readonly ArtifactFile[]) =>
    new Map<string, string | undefined>(
      files.map((file) => [file.path, file.base64]),
    );

  let created = 0;

  return {
    writes,
    reads,
    api: {
      read: async ({
        artifactId,
        revision,
      }: {
        readonly artifactId: string;
        readonly revision?: number;
      }): Promise<ArtifactRevisionRead | undefined> => {
        reads.push(artifactId);
        const stored = store.get(artifactId);

        if (stored === undefined) {
          return undefined;
        }

        const index = (revision ?? stored.revisions.length) - 1;
        const at = stored.revisions[index];

        if (at === undefined) {
          return undefined;
        }

        return {
          ...recordOf(artifactId, index),
          entries: at.entries.map((entry) => {
            const base64 = at.bytes.get(entry.path);

            return base64 === undefined ? entry : { ...entry, base64 };
          }),
        };
      },
      revisions: async ({ artifactId }: { readonly artifactId: string }) => {
        reads.push(artifactId);
        const stored = store.get(artifactId);

        return stored === undefined
          ? []
          : stored.revisions.map((_, index) => recordOf(artifactId, index));
      },
      create: async (input: ArtifactWrite['input']) => {
        writes.push({ method: 'create', input });
        created += 1;
        const artifactId = `diagram-${String(created).padStart(4, '0')}`;
        store.set(artifactId, {
          kind: String(input.kind),
          title: String(input.title),
          ...(input.notes === undefined ? {} : { notes: input.notes }),
          revisions: [
            {
              entries: input.entries,
              bytes: bytesOf(input.files),
              ...(input.path === undefined ? {} : { path: input.path }),
            },
          ],
        });

        return recordOf(artifactId, 0);
      },
      revise: async (input: ArtifactWrite['input']) => {
        writes.push({ method: 'revise', input });
        const artifactId = String(input.artifactId);
        const stored = store.get(artifactId);

        if (stored === undefined) {
          throw new Error(`no artifact ${artifactId}`);
        }

        stored.revisions.push({
          entries: input.entries,
          bytes: bytesOf(input.files),
          ...(input.path === undefined ? {} : { path: input.path }),
          ...(input.changeNote === undefined
            ? {}
            : { changeNote: input.changeNote }),
        });

        return recordOf(artifactId, stored.revisions.length - 1);
      },
    },
  };
};

/* Comments ------------------------------------------------------------------- */

export const fakeComments = (
  comments: readonly Comment[] = [],
  fail = false,
) => ({
  list: async () => {
    if (fail) {
      throw new Error('comments log offline');
    }

    return comments;
  },
});

/* The whole world ------------------------------------------------------------ */

export interface WorldOptions {
  readonly files?: Record<string, string | Uint8Array>;
  readonly dirs?: readonly string[];
  readonly artifacts?: readonly SeedArtifact[];
  readonly comments?: readonly Comment[];
  readonly commentsFail?: boolean;
  readonly lease?: LeaseStatus;
  readonly links?: FakeSandboxOptions['links'];
  readonly specials?: FakeSandboxOptions['specials'];
  readonly exec?: FakeSandboxOptions['exec'];
  readonly failWrites?: FakeSandboxOptions['failWrites'];
}

/** Services over in-memory boundaries, and the handles a test observes them by. */
export const world = (options: WorldOptions = {}) => {
  const sandbox = fakeSandbox(options.files, options.dirs, options);
  const artifacts = fakeArtifacts(options.artifacts);
  const services = servicesFor((id) => {
    switch (id) {
      case 'runtime.lease/v1':
        return fakeLease(sandbox, options.lease);
      case 'runtime.workspace/v1':
        return fakeWorkspace();
      case 'artifacts/v1':
        return artifacts.api;
      case 'comments/v1':
        return fakeComments(options.comments, options.commentsFail);
      default:
        throw new Error(`unexpected contract ${id}`);
    }
  });

  return { sandbox, artifacts, services };
};
