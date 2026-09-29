import { Buffer } from 'node:buffer';

import { listSandboxRepos, type Sandbox, workspacePathKind } from 'sandbox';

/** The largest text payload the content route returns. */
export const CONTENT_LIMIT_BYTES = 262_144;

export type ProjectFileRead =
  | { readonly status: 'escaped' | 'missing' | 'not_file' }
  | {
      readonly status: 'read';
      readonly content: string;
      readonly truncated: boolean;
      readonly binary: boolean;
    };

/** Reads one workspace file as bounded UTF-8 text, never a mangled binary. */
export const readProjectFile = async (
  sandbox: Sandbox,
  path: string,
): Promise<ProjectFileRead> => {
  const kind = await workspacePathKind(sandbox, path);

  if (kind === 'escaped') return { status: 'escaped' };
  if (kind === 'missing') return { status: 'missing' };
  if (kind !== 'file') return { status: 'not_file' };

  // One bounded read: ask for one byte past the cap so truncation is visible.
  const result = await sandbox.exec({
    cmd: ['head', '-c', String(CONTENT_LIMIT_BYTES + 1), '--', path],
  });

  if (result.exitCode !== 0) return { status: 'missing' };

  const bytes = result.stdoutBytes;
  const truncated = bytes.byteLength > CONTENT_LIMIT_BYTES;
  const binary = bytes.includes(0);
  const content = binary
    ? ''
    : Buffer.from(bytes.subarray(0, CONTENT_LIMIT_BYTES)).toString('utf8');

  return { status: 'read', content, truncated, binary };
};

export type ProjectChangeStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'untracked';
export type ProjectChange = {
  readonly path: string;
  readonly status: ProjectChangeStatus;
};
export type ProjectChangeSet = {
  readonly path: string;
  readonly diff: string;
  readonly changes: readonly ProjectChange[];
};

/**
 * The workspace's Git state, one entry per repository it holds: each repository's
 * tracked diff plus its own change list, including the untracked files. The
 * changes list cannot come from `Sandbox.diff`, because a diff never contains
 * untracked files, so it is read through `exec` at the repository root; the diff
 * itself still goes through the `Sandbox` contract, scoped to that same root.
 * Discovery stops at each repository boundary, so a repository nested in another
 * is left to the outer one, exactly as Git reports it.
 */
export const projectChanges = async (
  sandbox: Sandbox,
): Promise<readonly ProjectChangeSet[]> => {
  const repos = await listSandboxRepos(sandbox);

  // A workspace root that is missing or not a directory holds no repository.
  if (repos.status !== 'listed') return [];

  const entries = await Promise.all(
    repos.repositories.map(
      async ({ path }): Promise<ProjectChangeSet | undefined> => {
        // `-C` sets the repository; the workspace root is git's own default.
        const cwd = path === '' ? sandbox.root : path;

        const status = await sandbox.exec({
          cmd: ['git', '-C', cwd, 'status', '--porcelain'],
        });

        // A non-zero exit means git refused to read this repository.
        if (status.exitCode !== 0) return undefined;

        return {
          path,
          diff: await sandbox.diff({ cwd }),
          changes: status.stdout.split('\n').flatMap((line) => {
            const change = parseChange(line);
            return change === undefined ? [] : [change];
          }),
        };
      },
    ),
  );

  return entries.filter((entry) => entry !== undefined);
};

/** One porcelain line: two status characters, a space, then the path. */
const parseChange = (line: string): ProjectChange | undefined => {
  if (line.length < 4) return undefined;

  const code = line.slice(0, 2);
  const value = line.slice(3);

  if (value === '') return undefined;
  if (code === '??') return { path: value, status: 'untracked' };
  if (code.includes('R')) {
    const destination = value.includes(' -> ')
      ? value.split(' -> ').at(-1)
      : undefined;
    return destination === undefined
      ? undefined
      : { path: destination, status: 'renamed' };
  }
  if (code.includes('A')) return { path: value, status: 'added' };
  if (code.includes('D')) return { path: value, status: 'deleted' };

  return { path: value, status: 'modified' };
};
