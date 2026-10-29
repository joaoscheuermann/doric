// The vendored draw.io webapp as main finds it on disk: its manifest says
// which version `drawio-webapp/vendor.mjs` wrote.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { DrawioDescription } from 'bundle/contracts';

/**
 * `assets/drawio/manifest.json`, written by `drawio-webapp/vendor.mjs`: the
 * vendored draw.io version and the SHA-256 (lowercase hex) of every file
 * under `webapp/`, keyed by its POSIX path relative to `webapp/`.
 */
export interface DrawioManifest {
  readonly version: string;
  readonly files: Readonly<Record<string, string>>;
}

const MISSING: DrawioDescription = Object.freeze({
  available: false,
  reason: 'missing-assets',
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isManifest = (value: unknown): value is DrawioManifest =>
  isRecord(value) &&
  typeof value.version === 'string' &&
  value.version !== '' &&
  isRecord(value.files) &&
  Object.values(value.files).every((hash) => typeof hash === 'string');

/**
 * Reads `<root>/manifest.json`. A valid manifest with a non-empty string
 * `version` → `{ available: true, version }`. Missing, unreadable or
 * malformed → `{ available: false, reason: 'missing-assets' }`. Never
 * rejects; does not check file hashes.
 */
export const describeDrawio = async (
  root: string,
): Promise<DrawioDescription> => {
  try {
    const manifest: unknown = JSON.parse(
      await readFile(join(root, 'manifest.json'), 'utf8'),
    );

    return isManifest(manifest)
      ? { available: true, version: manifest.version }
      : MISSING;
  } catch {
    return MISSING;
  }
};
