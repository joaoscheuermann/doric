// Dev-only: the `doric.catalog/v1` distribution the fake host serves.
//
// The real host computes it from a booted kernel generation
// (`app/backend/doric-host/src/lib/bridge/catalog.ts`). The fake host skips the
// kernel — no Postgres, no generation processes — and reads the same staged
// bundle directories the host build produces, so what the desktop downloads is
// the repository's own bundle code. The catalog is built once per "generation";
// `reload()` publishes a new one after the staged files change.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  buildCatalog,
  discoverBundles,
  distributionFor,
  PLATFORM_VERSION,
  readComposition,
  stageBundles,
} from 'bundle';
import { DiagnosticsStore, statesOf } from 'bundle/runtime';

const sha256Of = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** A refusal the bridge answers with a `ContractError` code of our choosing. */
export class DevHostError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DevHostError';
    this.code = code;
  }
}

/**
 * The staged bundles the catalog is built from.
 *
 * `override` (or an existing default) wins. Otherwise the fake host stages the
 * bundles the host build stages — the list is the one
 * `app/backend/doric-host/project.json` hands `bundle`'s `stage` command — into
 * a git-ignored directory, so a worktree whose `dist/bundles` is absent still
 * serves the local bundle code.
 */
export const resolveBundlesRoot = async ({ root, override, log }) => {
  if (override !== undefined) {
    const explicit = resolve(override);

    if (!existsSync(explicit)) {
      throw new Error(`No staged bundles at ${explicit}.`);
    }

    return explicit;
  }

  const staged = join(root, 'app/backend/doric-host/dist/bundles');

  if (existsSync(staged)) return staged;

  const project = JSON.parse(
    await readFile(join(root, 'app/backend/doric-host/project.json'), 'utf8'),
  );
  const command = project.targets?.['build-bundles']?.options?.commands?.[0];
  const words = typeof command === 'string' ? command.split(/\s+/) : [];
  const at = words.indexOf('stage');

  if (at === -1 || words.length < at + 3) {
    throw new Error(
      `No staged bundles at ${staged}, and ${join(root, 'app/backend/doric-host/project.json')} has no stage command to rebuild them from.`,
    );
  }

  const destination = join(root, 'tmp/fake-host/bundles');

  log.note(
    `no staged bundles at ${staged}: staging ${words.length - at - 2} bundles into ${destination}`,
  );
  // `stage` reads `<dir>/dist`: the command's directories are workspace-relative.
  await stageBundles(
    destination,
    words.slice(at + 2).map((dir) => resolve(root, dir)),
  );

  return destination;
};

/**
 * Builds one generation's catalog from a staged bundles directory.
 *
 * Every bundle is reported `active`: the fake host runs no activation, and a
 * non-active bundle is what the desktop quarantines out of the window.
 */
export const createDevCatalog = async ({
  bundlesRoot,
  compositionPath,
  generation,
  hostBoot,
}) => {
  const installed = await discoverBundles(bundlesRoot);
  const composition = await readComposition(compositionPath);
  const resolved = buildCatalog({
    installed,
    embedded: [],
    composition,
    platformVersion: PLATFORM_VERSION,
    generation,
  });
  const diagnostics = new DiagnosticsStore({ generation });

  diagnostics.load(resolved);

  for (const entry of resolved.entries) {
    diagnostics.setState(entry.id, 'active');
  }

  const catalog = await distributionFor({
    resolved,
    states: statesOf(diagnostics.snapshot()),
    hostBoot,
    platformVersion: PLATFORM_VERSION,
  });

  // sha256 → the installed file that holds it. `distributionFor` hashes the
  // files; the directory layout is the resolved environment's, as the host's
  // own distribution provider maps them.
  const files = new Map();

  for (const [index, bundle] of catalog.bundles.entries()) {
    const source = resolved.entries[index]?.source;

    if (source?.kind !== 'installed') continue;

    for (const file of bundle.files) {
      if (!files.has(file.sha256)) {
        files.set(file.sha256, join(source.dir, ...file.path.split('/')));
      }
    }
  }

  return {
    catalog,
    files,
    bundleIds: catalog.bundles.map((bundle) => bundle.id),
    /** The bytes of one distributed file, verified against its hash. */
    artifact: async (sha256) => {
      const path = files.get(sha256);

      if (path === undefined) {
        throw new DevHostError(
          'not_found',
          `No generation distributes an artifact with SHA-256 ${sha256}.`,
        );
      }

      const bytes = await readFile(path).catch(() => undefined);

      if (bytes === undefined || sha256Of(bytes) !== sha256) {
        throw new DevHostError(
          'not_found',
          `The artifact ${sha256} is missing from ${path}.`,
        );
      }

      return { sha256, base64: bytes.toString('base64') };
    },
  };
};
