// The import map every window carries (decision 72): the platform entries
// `doric-platform` generated plus, for each bundle of the window's client
// generation, `<id>/contracts` and the prefix `<id>/contracts/gen/` (A53).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { DORIC_ORIGIN } from './scheme';

export interface ImportMap {
  readonly imports: Readonly<Record<string, string>>;
}

/**
 * A bundle of a generation that ships contracts code: `contracts/index.js`,
 * generated files under `contracts/gen/`, or both.
 */
export interface ContractsArtifact {
  readonly id: string;
  readonly version: string;
  /**
   * Dist-relative entry, `contracts/index.js`; absent for a bundle that
   * ships generated code only (`transport`).
   */
  readonly entry?: string;
}

/** Reads `importmap.platform.json` of the platform assets. */
export const platformImportMap = (platformRoot: string): ImportMap => {
  const parsed = JSON.parse(
    readFileSync(join(platformRoot, 'importmap.platform.json'), 'utf8'),
  ) as { imports?: unknown };

  if (
    typeof parsed.imports !== 'object' ||
    parsed.imports === null ||
    Array.isArray(parsed.imports)
  ) {
    throw new Error('importmap.platform.json has no "imports" object.');
  }

  return { imports: { ...(parsed.imports as Record<string, string>) } };
};

/** The bundle URL of a generation's artifact. */
export const bundleUrl = (
  bundle: { readonly id: string; readonly version: string },
  path: string,
): string => `${DORIC_ORIGIN}/bundles/${bundle.id}@${bundle.version}/${path}`;

/**
 * The platform map plus, for each artifact, `"<id>/contracts"` (when it has
 * an `entry`) and the prefix `"<id>/contracts/gen/"` for
 * `bundleUrl(artifact, "contracts/gen/")`, so
 * `<id>/contracts/gen/<path>_pb.js` resolves to the file tsc wrote to the
 * bundle's `dist/contracts/gen/<path>_pb.js`.
 *
 * Accepts any artifacts; does not read files, so a prefix entry is added
 * whether or not the bundle ships a generated file (an import of a missing
 * one is the protocol's 404). An artifact entry overrides a platform entry
 * of the same specifier; `bundle` is never an artifact (the manifest schema
 * refuses that id), so `bundle/contracts/gen/…` keeps the platform's
 * per-file entries. Never throws. `base` is not modified.
 */
export const generationImportMap = (
  base: ImportMap,
  artifacts: readonly ContractsArtifact[],
): ImportMap => {
  const imports: Record<string, string> = { ...base.imports };

  for (const artifact of artifacts) {
    if (artifact.entry !== undefined) {
      imports[`${artifact.id}/contracts`] = bundleUrl(artifact, artifact.entry);
    }

    imports[`${artifact.id}/contracts/gen/`] = bundleUrl(
      artifact,
      'contracts/gen/',
    );
  }

  return { imports };
};

/** The exact text the shell carries between its `<script>` tags. */
export const importMapText = (map: ImportMap): string =>
  JSON.stringify({ imports: map.imports });

const platformPrefix = `${DORIC_ORIGIN}/platform/`;

/**
 * The same map for the desktopMain utility process: `doric://app/platform/…`
 * becomes a `file://` URL under `platformRoot` (Node resolves file URLs only).
 */
export const fileImportMap = (
  map: ImportMap,
  platformRoot: string,
): Record<string, string> => {
  const imports: Record<string, string> = {};

  for (const [specifier, target] of Object.entries(map.imports)) {
    if (target.startsWith(platformPrefix)) {
      imports[specifier] = pathToFileURL(
        join(platformRoot, ...target.slice(platformPrefix.length).split('/')),
      ).href;
    }
  }

  return imports;
};
