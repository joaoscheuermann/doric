// Reads of Project files through `files/v1`: the source of a program's
// component, its sheet's bytes, and whether a directory is a repository root.
// The compiler and the harness search read through these.

import { type Call, ContractError, type Services } from 'bundle/contracts';

import {
  kernelPapercraftPorts,
  type PapercraftFiles,
  type ReadAt,
} from './ports.js';

/** The reads the compiler and the harness search make, bound to one Project and call. */
export interface ProjectReaders {
  /**
   * The file's text. Rejects `invalid_input` (today's texts) when the lease is not ready, the read failed, or the file
   * is truncated or binary; a missing file / directory answers `undefined` unless `strict`.
   */
  source(path: string, strict?: boolean): Promise<string | undefined>;
  /** The whole file's bytes, or `undefined` for anything short of that (never rejects). */
  bytes(path: string): Promise<Uint8Array | undefined>;
  /** Whether `<dir>/.git` reads as a file or is a directory (D15); a failed read answers `false`. */
  isRepositoryRoot(dir: string): Promise<boolean>;
}

/** Today's three probes over `files`, at `at`. No I/O at creation. */
export const projectReaders = (
  files: PapercraftFiles,
  at: ReadAt,
): ProjectReaders => ({
  source: async (path, strict = false) => {
    const outcome = await files.content(path, at);

    if (outcome.status !== 'ready') {
      throw new ContractError(
        'invalid_input',
        `The Project sandbox is not ready to read "${path}" (${outcome.status}).`,
        { path, status: outcome.status },
      );
    }

    const read = outcome.value;

    if (
      !strict &&
      (read.status === 'not_found' || read.status === 'not_file')
    ) {
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
  },
  bytes: async (path) => {
    const outcome = await Promise.resolve()
      .then(() => files.readBytes(path, at))
      .catch(() => undefined);

    if (outcome?.status !== 'ready') return undefined;

    const read = outcome.value;

    return read.status === 'read' && !read.truncated ? read.bytes : undefined;
  },
  isRepositoryRoot: async (dir) => {
    const outcome = await Promise.resolve()
      .then(() => files.content(dir === '.' ? '.git' : `${dir}/.git`, at))
      .catch(() => undefined);

    return (
      outcome?.status === 'ready' &&
      (outcome.value.status === 'read' || outcome.value.status === 'not_file')
    );
  },
});

/** The kernel's readers for the Project `call` is scoped to. */
const kernelReaders = (services: Services, call: Call): ProjectReaders =>
  projectReaders(kernelPapercraftPorts(services).files, {
    projectId: call.scope?.projectId ?? '',
    call,
  });

/**
 * Reads one Project file as text through `files/v1`, refusing an unreadable
 * sandbox or a non-plain-text source. A file that is not there answers
 * `undefined` unless `strict`: the compiler probes the candidates of an
 * import this way.
 */
export const probeSource = (
  services: Services,
  call: Call,
  path: string,
  strict = false,
): Promise<string | undefined> =>
  kernelReaders(services, call).source(path, strict);

/**
 * Reads one Project file's bytes through `files/v1` (base64, files/v1 1.1.0):
 * what a preview's sheet names, a font or an image. Anything short of the
 * whole file answers `undefined`, and the sheet goes without it.
 */
export const probeBytes = (
  services: Services,
  call: Call,
  path: string,
): Promise<Uint8Array | undefined> => kernelReaders(services, call).bytes(path);

/**
 * Whether a Project directory is a repository root, through `files/v1`: its
 * `.git` reads as a file (a worktree's) or is a directory (D15). The harness
 * search stops after such a directory. A failed read answers `false`.
 */
export const probeRepositoryRoot = (
  services: Services,
  call: Call,
  dir: string,
): Promise<boolean> => kernelReaders(services, call).isRepositoryRoot(dir);
