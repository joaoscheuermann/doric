// `doric.cache/v1`: one directory per bundle, distinct from the artifact
// cache (`userData/bundles/`).

import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { ContractError } from 'bundle/contracts';

const bundleIdPattern = /^[a-z][a-z0-9-]*$/;

export const cacheDirectory = async (
  root: string,
  bundleId: string,
): Promise<string> => {
  if (!bundleIdPattern.test(bundleId)) {
    throw new ContractError(
      'invalid_input',
      `"${bundleId}" is not a bundle ID with a cache directory.`,
    );
  }

  const directory = resolve(join(root, bundleId));

  await mkdir(directory, { recursive: true });

  return directory;
};
