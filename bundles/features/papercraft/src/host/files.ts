// Reads of Project files through `files/v1`: the source of a program's
// component, its sheet's bytes, and whether a directory is a repository root.
// The compiler and the harness search read through these.

import { type Call, ContractError, type Services } from 'bundle/contracts';

import { FilesV1 } from '../contracts/index.js';

/**
 * Reads one Project file as text through `files/v1`, refusing an unreadable
 * sandbox or a non-plain-text source. A file that is not there answers
 * `undefined` unless `strict`: the compiler probes the candidates of an
 * import this way.
 */
export const probeSource = async (
  services: Services,
  call: Call,
  path: string,
  strict = false,
): Promise<string | undefined> => {
  const outcome = await services
    .use(FilesV1, call.scope)
    .content({ path }, call);

  if (outcome.status !== 'ready') {
    throw new ContractError(
      'invalid_input',
      `The Project sandbox is not ready to read "${path}" (${outcome.status}).`,
      { path, status: outcome.status },
    );
  }

  const read = outcome.value;

  if (!strict && (read.status === 'not_found' || read.status === 'not_file')) {
    return undefined;
  }

  if (read.status !== 'read') {
    throw new ContractError(
      'invalid_input',
      `The source "${path}" could not be read (${read.status}).`,
      { path, status: read.status },
    );
  }

  if (read.truncated || read.binary) {
    throw new ContractError(
      'invalid_input',
      `The source "${path}" is not previewable plain text.`,
      { path, truncated: read.truncated, binary: read.binary },
    );
  }

  return read.content;
};

/**
 * Reads one Project file's bytes through `files/v1` (base64, files/v1 1.1.0):
 * what a preview's sheet names, a font or an image. Anything short of the
 * whole file answers `undefined`, and the sheet goes without it.
 */
export const probeBytes = async (
  services: Services,
  call: Call,
  path: string,
): Promise<Uint8Array | undefined> => {
  const outcome = await Promise.resolve()
    .then(() =>
      services
        .use(FilesV1, call.scope)
        .content({ path, encoding: 'base64' }, call),
    )
    .catch(() => undefined);

  if (outcome?.status !== 'ready') return undefined;

  const read = outcome.value;

  return read.status === 'read' && !read.truncated
    ? Buffer.from(read.content, 'base64')
    : undefined;
};

/**
 * Whether a Project directory is a repository root, through `files/v1`: its
 * `.git` reads as a file (a worktree's) or is a directory (D15). The harness
 * search stops after such a directory. A failed read answers `false`.
 */
export const probeRepositoryRoot = async (
  services: Services,
  call: Call,
  dir: string,
): Promise<boolean> => {
  const outcome = await Promise.resolve()
    .then(() =>
      services
        .use(FilesV1, call.scope)
        .content({ path: dir === '.' ? '.git' : `${dir}/.git` }, call),
    )
    .catch(() => undefined);

  return (
    outcome?.status === 'ready' &&
    (outcome.value.status === 'read' || outcome.value.status === 'not_file')
  );
};
