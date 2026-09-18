import fs from 'node:fs';
import path from 'node:path';

import { glob } from 'glob';

import {
  createOkfError,
  isAbortError,
  isOkfError,
} from './classes/okf-error.js';
import { DEFAULT_BATCH_SIZE } from './constants.js';
import { filterIgnored } from './git.js';

export type WalkOptions = {
  readonly batchSize?: number;
  readonly ignore?: readonly string[];
  readonly signal?: AbortSignal;
};

/** Discovers every eligible file, then processes sequential concurrent batches. */
export async function walk(
  root: string,
  callback: (file: string, body: string) => Promise<void>,
  options: WalkOptions = {},
): Promise<readonly string[]> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;

  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new Error('batchSize must be a positive integer');
  }

  const relativeFiles = await discover(root, options.ignore ?? []);

  const files = relativeFiles.map((file) =>
    path.join(root, ...file.split('/')),
  );
  const textFiles: string[] = [];

  for (let offset = 0; offset < files.length; offset += batchSize) {
    options.signal?.throwIfAborted();

    await Promise.all(
      files.slice(offset, offset + batchSize).map(async (file) => {
        options.signal?.throwIfAborted();

        if (!(await isRegularFile(file))) {
          return;
        }

        const buffer = await readSource(file);

        if (isBinary(buffer)) {
          return;
        }

        const body = buffer.toString('utf-8');

        textFiles.push(file);

        await callback(file, body);
      }),
    );
  }

  return textFiles.sort();
}

const discover = async (
  root: string,
  ignore: readonly string[],
): Promise<readonly string[]> => {
  try {
    const candidates = (
      await glob(['**/*', '**/.gitignore'], {
        cwd: root,
        ignore: ['**/.agents/**', '**/.doric/**', '**/.git/**'],
        nodir: true,
        windowsPathsNoEscape: true,
      })
    )
      .map(normalize)
      .sort();
    const discovered = await regularFiles(root, candidates);

    return await filterIgnored(root, discovered, ignore);
  } catch (error) {
    if (isOkfError(error) || isAbortError(error)) {
      throw error;
    }

    throw createOkfError('OKF_DISCOVERY_FAILED');
  }
};

const readSource = async (file: string): Promise<Buffer> => {
  try {
    return await fs.promises.readFile(file);
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }

    throw createOkfError('OKF_DISCOVERY_FAILED');
  }
};

const normalize = (value: string): string =>
  value.replaceAll('\\', '/').replace(/^\.\//u, '');

const regularFiles = async (
  root: string,
  files: readonly string[],
): Promise<readonly string[]> => {
  const checked = await Promise.all(
    files.map(async (file) => ({
      file,
      regular: await isRegularFile(path.join(root, ...file.split('/'))),
    })),
  );

  return checked.filter(({ regular }) => regular).map(({ file }) => file);
};

const isRegularFile = async (file: string): Promise<boolean> => {
  try {
    return (await fs.promises.lstat(file)).isFile();
  } catch {
    return false;
  }
};

const isBinary = (buffer: Buffer): boolean => {
  if (buffer.includes(0)) {
    return true;
  }

  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return true;
  }

  const controls = buffer.reduce(
    (count, byte) =>
      count + (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13 ? 1 : 0),
    0,
  );

  return buffer.length > 0 && controls / buffer.length > 0.3;
};
