// files.sandbox/v1's tree, read per directory: the Files panel reads its root
// first, a directory when it opens (showing it as loading meanwhile), and a
// refresh rereads the root and the open directories in one call — never the
// whole workspace. Observed through the store's tree observation and the
// expansion store the panel and Reveal in Files write, over fake host reads
// that record each `directories` call and answer from an in-memory workspace.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import type { FilesReads } from '../src/client/api/reads.js';
import type {
  DirectoryListing,
  ProjectDirectoriesResult,
  ProjectTreeNode,
} from '../src/client/reads/project-files.js';
import {
  createSandboxStore,
  rootOf,
  type SandboxStore,
} from '../src/client/sandbox-store.js';
import {
  expansionScope,
  expansionStore,
  resetExpansion,
} from '../src/client/stores/expansion.js';
import type { TreeObservation } from '../src/contracts/index.js';

const PROJECT = 'p-1';

/** A workspace as directory → its visible entries, by path. */
type Workspace = Record<string, readonly string[]>;

const listingOf = (workspace: Workspace, path: string): DirectoryListing => {
  const names = workspace[path];
  if (names === undefined) return { status: 'not_found' };
  return {
    status: 'listed',
    entries: names.map((name) => {
      const child = path === '' ? name : `${path}/${name}`;
      return {
        name,
        path: child,
        type: workspace[child] === undefined ? 'file' : 'directory',
      };
    }),
  };
};

interface Host {
  workspace: Workspace;
  /** Each `directories` call's paths, in call order. */
  readonly calls: (readonly string[])[];
  /** When set, the next calls wait for it; `release` answers them. */
  hold: boolean;
  release(): void;
  /** When set, the next call fails with it. */
  failure?: Error;
}

const fakeHost = (workspace: Workspace): Host & { reads: FilesReads } => {
  let waiting: (() => void)[] = [];
  const host: Host & { reads: FilesReads } = {
    workspace,
    calls: [],
    hold: false,
    release: () => {
      const answers = waiting;
      waiting = [];
      for (const answer of answers) answer();
    },
    reads: {
      tree: async () => {
        throw new Error('The tree is not read whole.');
      },
      file: async () => ({ status: 'not_found' }),
      directories: async (_projectId, paths) => {
        host.calls.push([...paths]);
        if (host.hold)
          await new Promise<void>((resolve) => waiting.push(resolve));
        const failure = host.failure;
        if (failure !== undefined) {
          host.failure = undefined;
          throw failure;
        }
        const directories: Record<string, DirectoryListing> = {};
        for (const path of paths)
          directories[path] = listingOf(host.workspace, path);
        const result: ProjectDirectoriesResult = {
          status: 'ready',
          directories,
        };
        return result;
      },
    },
  };
  return host;
};

const settle = async (): Promise<void> => {
  for (let index = 0; index < 20; index += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
};

/** Waits out the refresh queue's 250 ms coalescing, then the reads. */
const refreshed = async (
  store: SandboxStore,
  periodic = false,
): Promise<void> => {
  await store.refresh(PROJECT, periodic);
  await settle();
};

interface Watch {
  readonly host: ReturnType<typeof fakeHost>;
  readonly store: SandboxStore;
  latest(): TreeObservation;
  open(...paths: string[]): void;
  close(...paths: string[]): void;
}

let stores: SandboxStore[] = [];
let disposables: { dispose(): void }[] = [];

beforeEach(() => resetExpansion());
afterEach(() => {
  for (const disposable of disposables) disposable.dispose();
  for (const store of stores) store.dispose();
  disposables = [];
  stores = [];
  resetExpansion();
});

const watch = async (
  workspace: Workspace,
  cwd = '/workspace',
  open: readonly string[] = [],
): Promise<Watch> => {
  const host = fakeHost(workspace);
  const store = createSandboxStore(() => host.reads);
  stores.push(store);
  const scope = expansionScope(PROJECT, rootOf(cwd));
  if (open.length > 0) expansionStore.getState().expand(scope, open);
  let latest: TreeObservation | undefined;
  disposables.push(
    store.observeTree({ projectId: PROJECT, cwd }, (state) => {
      latest = state;
    }),
  );
  await settle();
  return {
    host,
    store,
    latest: () => {
      assert.ok(latest, 'the tree was observed');
      return latest;
    },
    open: (...paths) => expansionStore.getState().expand(scope, paths),
    close: (...paths) => expansionStore.getState().collapse(scope, paths),
  };
};

/** The tree's paths, a directory's children nested after it. */
const shown = (observation: TreeObservation): readonly string[] => {
  const walk = (nodes: readonly ProjectTreeNode[]): string[] =>
    nodes.flatMap((node) => [
      node.type === 'directory' ? `${node.path}/` : node.path,
      ...(node.children === undefined ? [] : walk(node.children)),
    ]);
  return observation.read.status === 'ready'
    ? walk(observation.read.value)
    : [];
};

const loadingOf = (observation: TreeObservation): readonly string[] =>
  [...(observation.loading ?? [])].sort();

const sorted = (paths: readonly string[]): readonly string[] =>
  [...paths].sort();

const WORKSPACE: Workspace = {
  '': ['src', 'docs', 'README.md'],
  src: ['lib', 'main.ts'],
  'src/lib': ['util.ts'],
  docs: ['guide.md'],
};

describe('the Files tree, read per directory', () => {
  test('reads the root first and nothing below it', async () => {
    const { host, latest } = await watch(WORKSPACE);

    assert.deepEqual(host.calls, [['']]);
    assert.deepEqual(shown(latest()), ['src/', 'docs/', 'README.md']);
  });

  test('a directory that opens shows as loading, then shows its children', async () => {
    const { host, latest, open } = await watch(WORKSPACE);
    host.hold = true;

    open('src');
    await settle();

    assert.deepEqual(host.calls.at(-1), ['src']);
    assert.deepEqual(loadingOf(latest()), ['src']);
    assert.deepEqual(shown(latest()), ['src/', 'docs/', 'README.md']);

    host.release();
    await settle();

    assert.deepEqual(loadingOf(latest()), []);
    assert.deepEqual(shown(latest()), [
      'src/',
      'src/lib/',
      'src/main.ts',
      'docs/',
      'README.md',
    ]);
  });

  test('a refresh rereads the root and the open directories in one call, and no closed one', async () => {
    const { host, latest, open, close, store } = await watch(WORKSPACE);
    open('src');
    await settle();
    open('docs');
    await settle();
    close('docs');
    host.calls.length = 0;
    host.workspace = { ...WORKSPACE, src: ['lib', 'main.ts', 'new.ts'] };

    await refreshed(store);

    assert.equal(host.calls.length, 1);
    assert.deepEqual(sorted(host.calls[0] ?? []), ['', 'src']);
    assert.deepEqual(shown(latest()), [
      'src/',
      'src/lib/',
      'src/main.ts',
      'src/new.ts',
      'docs/',
      'README.md',
    ]);

    // The closed directory was not reread, so opening it reads it again.
    open('docs');
    await settle();
    assert.deepEqual(host.calls.at(-1), ['docs']);
  });

  test('directories open before the tree was read are read with its root', async () => {
    const { host, latest } = await watch(WORKSPACE, '/workspace', [
      'src',
      'src/lib',
    ]);

    assert.equal(host.calls.length, 1);
    assert.deepEqual(sorted(host.calls[0] ?? []), ['', 'src', 'src/lib']);
    assert.deepEqual(shown(latest()), [
      'src/',
      'src/lib/',
      'src/lib/util.ts',
      'src/main.ts',
      'docs/',
      'README.md',
    ]);
  });

  test('opening a whole chain at once (Reveal in Files) reads it in one call', async () => {
    const { host, latest, open } = await watch(WORKSPACE);
    host.calls.length = 0;

    open('src', 'src/lib');
    await settle();

    assert.equal(host.calls.length, 1);
    assert.deepEqual(sorted(host.calls[0] ?? []), ['src', 'src/lib']);
    assert.ok(shown(latest()).includes('src/lib/util.ts'));
  });

  test('a tree rooted at the working directory reads from it', async () => {
    const { host, latest, open } = await watch(WORKSPACE, '/workspace/src');
    open('src/lib');
    await settle();

    assert.deepEqual(host.calls, [['src'], ['src/lib']]);
    assert.deepEqual(shown(latest()), [
      'src/lib/',
      'src/lib/util.ts',
      'src/main.ts',
    ]);
  });

  test('a directory whose read fails closes again and its failure is the tree error', async () => {
    const { host, latest, open, store } = await watch(WORKSPACE);
    host.failure = new Error('The request could not be completed.');

    open('src');
    await settle();

    assert.equal(latest().error, 'The request could not be completed.');
    assert.deepEqual(loadingOf(latest()), []);
    assert.deepEqual(
      [...(expansionStore.getState().views[expansionScope(PROJECT, '')] ?? [])],
      [],
    );
    assert.deepEqual(shown(latest()), ['src/', 'docs/', 'README.md']);

    // The toast's retry refreshes the Project, which clears the failure.
    await refreshed(store);
    assert.equal(latest().error, undefined);
  });

  test('an open directory that disappears, or becomes a file, leaves the tree', async () => {
    const { host, latest, open, store } = await watch(WORKSPACE);
    open('src', 'docs');
    await settle();

    host.workspace = { '': ['src', 'README.md'], src: ['main.ts'] };
    await refreshed(store);
    assert.deepEqual(shown(latest()), ['src/', 'src/main.ts', 'README.md']);

    host.workspace = { '': ['src', 'README.md'] };
    host.calls.length = 0;
    await refreshed(store);
    assert.deepEqual(shown(latest()), ['src', 'README.md']);

    // A later refresh no longer asks for what is gone.
    host.calls.length = 0;
    await refreshed(store);
    assert.deepEqual(host.calls, [['']]);
  });

  test('a root that is gone answers not_found', async () => {
    const { latest } = await watch(WORKSPACE, '/workspace/missing');

    assert.deepEqual(latest().read, { status: 'not_found' });
  });

  test('another Project or root reads its own tree', async () => {
    const first = await watch(WORKSPACE, '/workspace', ['src']);
    const second = await watch(WORKSPACE, '/workspace/docs');

    assert.deepEqual(second.host.calls, [['docs']]);
    assert.deepEqual(shown(second.latest()), ['docs/guide.md']);
    assert.ok(shown(first.latest()).includes('src/main.ts'));
  });
});
