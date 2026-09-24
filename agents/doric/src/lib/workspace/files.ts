import { Buffer } from 'node:buffer';

import { type Sandbox, workspacePathKind } from 'sandbox';

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
export type ProjectChanges = {
  readonly repository: boolean;
  readonly diff: string;
  readonly changes: readonly ProjectChange[];
};

/**
 * The workspace's Git state: the tracked diff plus every change, including the
 * untracked files. The changes list cannot come from `Sandbox.diff`, because a
 * diff never contains untracked files, so it is read through `exec`; the diff
 * itself still goes through the `Sandbox` contract. Both describe the sandbox's
 * default working directory, which is the workspace root, where the agent
 * writes.
 */
export const projectChanges = async (
  sandbox: Sandbox,
  path?: string,
): Promise<ProjectChanges> => {
  const status = await sandbox.exec({
    cmd: [
      'git',
      'status',
      '--porcelain',
      ...(path === undefined ? [] : ['--', path]),
    ],
  });

  // A non-zero exit means the workspace holds no repository.
  if (status.exitCode !== 0)
    return { repository: false, diff: '', changes: [] };

  const diff = await sandbox.diff(path === undefined ? {} : { paths: [path] });

  return {
    repository: true,
    diff,
    changes: status.stdout.split('\n').flatMap((line) => {
      const change = parseChange(line);
      return change === undefined ? [] : [change];
    }),
  };
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
