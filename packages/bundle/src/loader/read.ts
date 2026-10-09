import { join } from 'node:path';

import { type Composition, parseComposition } from '../runtime/composition.js';
import { type Descriptor, parseDescriptor } from '../runtime/descriptor.js';
import { parseManifest, type ReadManifest } from '../runtime/manifest.js';
import { readText } from './skills.js';

const withCause = (message: string, cause: unknown): Error =>
  new Error(message, { cause });

const parseJson = (source: string, context: string): unknown => {
  try {
    return JSON.parse(source) as unknown;
  } catch (cause) {
    throw withCause(`Invalid ${context}.`, cause);
  }
};

/** Reads `<bundleDir>/manifest.json`: v1, or v0 converted in memory. */
export const readManifest = async (
  bundleDir: string,
): Promise<ReadManifest> => {
  const path = join(bundleDir, 'manifest.json');
  const context = `manifest "${path}"`;
  const document = parseJson(await readText(path, context), context);

  try {
    return parseManifest(document);
  } catch (cause) {
    throw withCause(`Invalid ${context}.`, cause);
  }
};

export class CompositionError extends Error {
  override readonly name = 'CompositionError';
  readonly path: string;

  constructor(path: string, cause: unknown) {
    super(
      `Invalid composition "${path}": ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.path = path;
  }
}

/** Reads and validates a composition JSON file. */
export const readComposition = async (path: string): Promise<Composition> => {
  try {
    const context = `composition "${path}"`;

    return parseComposition(parseJson(await readText(path, context), context));
  } catch (cause) {
    throw new CompositionError(path, cause);
  }
};

/** Reads `<bundleDir>/contracts.json`; undefined when the file does not exist. */
export const readDescriptor = async (
  bundleDir: string,
): Promise<Descriptor | undefined> => {
  const path = join(bundleDir, 'contracts.json');
  let source: string;

  try {
    source = await readText(path, `descriptor "${path}"`);
  } catch (error) {
    if ((error as { cause?: { code?: unknown } }).cause?.code === 'ENOENT') {
      return undefined;
    }

    throw error;
  }

  const context = `descriptor "${path}"`;

  try {
    return parseDescriptor(parseJson(source, context));
  } catch (cause) {
    throw withCause(`Invalid ${context}.`, cause);
  }
};
