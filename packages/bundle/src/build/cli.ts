import {
  copyFile,
  cp,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { Activate } from '../contracts/context.js';
import type { Environment } from '../contracts/ids.js';
import { SkillSchema } from '../contracts/skill.js';
import type { JsonObject } from '../contracts/types.js';
import { discoverSkills, readSkill } from '../loader/skills.js';
import type { Descriptor, DescriptorEntry } from '../runtime/descriptor.js';
import { descriptorSchema } from '../runtime/descriptor.js';
import { jsonEqual } from '../runtime/json-schema.js';
import {
  type ManifestV1,
  manifestV1Schema,
  parseContractEntry,
} from '../runtime/manifest.js';
import { installDomShim } from './dom-shim.js';
import { checkRecording, recordActivation } from './record.js';
import {
  contractDocument,
  type RecordedContract,
  schemaPath,
} from './schemas.js';

export class BuildError extends Error {
  override readonly name = 'BuildError';
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, 'utf8')) as unknown;

const exists = async (path: string): Promise<boolean> => {
  try {
    await readFile(path);

    return true;
  } catch {
    return false;
  }
};

/** The `*.md` files at any depth below `dir`, relative to it; none when `dir` is missing. */
const markdownBelow = async (dir: string): Promise<readonly string[]> => {
  try {
    const entries = await readdir(dir, {
      recursive: true,
      withFileTypes: true,
    });

    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => relative(dir, join(entry.parentPath, entry.name)));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
};

/**
 * Mirrors the Markdown files of `from` into `to`. Deletes every `*.md` file
 * at any depth below `to`, then copies every `*.md` file at any depth below
 * `from` to the same relative path under `to`, creating directories as needed.
 *
 * Files under `to` that are not `*.md` are kept, and so are directories,
 * including any left empty. A missing `from` copies nothing (the deletions
 * still happen); a missing `to` deletes nothing and is created only when
 * something is copied. Rejects with the fs error for any other read, delete
 * or copy failure.
 */
const copyMarkdown = async (from: string, to: string): Promise<void> => {
  for (const path of await markdownBelow(to)) {
    await rm(join(to, path));
  }

  for (const path of await markdownBelow(from)) {
    await mkdir(dirname(join(to, path)), { recursive: true });
    await copyFile(join(from, path), join(to, path));
  }
};

/**
 * Parts recorded at build time. A client part is imported and dry-activated
 * with the DOM shim installed (stage 9): it may touch the DOM at import time
 * only through `class … extends HTMLElement`.
 */
const parts: readonly {
  readonly path: string;
  readonly environment: Environment;
}[] = [
  { path: 'host/index.js', environment: 'host' },
  { path: 'desktop/index.js', environment: 'desktopMain' },
  { path: 'client/index.js', environment: 'client' },
];

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export interface BuildResult {
  readonly manifest: ManifestV1;
  readonly descriptor: Descriptor;
  readonly documents: ReadonlyMap<string, JsonObject>;
}

export interface BuildOptions {
  /** How the desktop and client parts are built (default production). */
  readonly mode?: 'production' | 'development';
}

/**
 * `build <bundleDir>` (after tsc): validates the v1 manifest, copies skills
 * and the host part's Markdown templates (every `.md` file below `src/host`,
 * which the host part reads at import time, so before the dry activation),
 * builds the desktop and client parts, dry-activates the parts, writes JSON
 * Schemas, `contracts.json` and package.json. The semver check against a
 * published baseline is not here yet: it returns with publishing (stage 11).
 */
export const buildBundle = async (
  bundleDir: string,
  options: BuildOptions = {},
): Promise<BuildResult> => {
  const root = resolve(bundleDir);
  const dist = join(root, 'dist');
  const manifestPath = join(root, 'manifest.json');
  const parsed = manifestV1Schema.safeParse(await readJson(manifestPath));

  if (!parsed.success) {
    throw new BuildError(
      `Invalid manifest "${manifestPath}": ${parsed.error.message}`,
    );
  }

  const manifest = parsed.data;

  await mkdir(dist, { recursive: true });

  for (const generated of [
    'skills',
    'schemas',
    'contracts.json',
    'manifest.json',
  ]) {
    await rm(join(dist, generated), { recursive: true, force: true });
  }

  await copyFile(manifestPath, join(dist, 'manifest.json'));

  const source = join(root, 'src');

  for (const path of await discoverSkills(source)) {
    try {
      const { skill } = await readSkill(source, path, {
        frontmatterAvailability: true,
      });

      SkillSchema.parse(skill);
    } catch (error) {
      throw new BuildError(
        `Invalid skill "${path}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    await mkdir(dirname(join(dist, path)), { recursive: true });
    await copyFile(join(source, path), join(dist, path));
  }

  await copyMarkdown(join(source, 'host'), join(dist, 'host'));

  // Loaded on demand: esbuild and Tailwind are build-time tools the host
  // runtime never needs.
  const { buildParts, PartBuildError } = await import('./parts.js');

  try {
    await buildParts({ bundleDir: root, mode: options.mode ?? 'production' });
  } catch (error) {
    if (error instanceof PartBuildError) {
      throw new BuildError(error.message);
    }

    throw error;
  }

  const recorded: RecordedContract[] = [];

  for (const part of parts) {
    const path = join(dist, part.path);

    if (!(await exists(path))) {
      continue;
    }

    const restore = part.environment === 'client' ? installDomShim() : null;

    try {
      let loaded: { readonly activate?: unknown };

      try {
        loaded = (await import(pathToFileURL(path).href)) as {
          readonly activate?: unknown;
        };
      } catch (error) {
        throw new BuildError(
          part.environment === 'client'
            ? `Loading ${part.path} failed: ${messageOf(error)}. A client module may touch the DOM at import time only through "class … extends HTMLElement"; load heavier modules with a dynamic import() inside a component.`
            : `Loading ${part.path} failed: ${messageOf(error)}`,
        );
      }

      if (typeof loaded.activate !== 'function') {
        throw new BuildError(
          `${part.path} does not export an activate function.`,
        );
      }

      try {
        recorded.push(
          ...(await recordActivation({
            manifest,
            environment: part.environment,
            activate: loaded.activate as Activate,
          })),
        );
      } catch (error) {
        throw new BuildError(
          `Dry activation of ${part.path} failed: ${messageOf(error)}`,
        );
      }
    } finally {
      restore?.();
    }
  }

  const problems = checkRecording(manifest, recorded);

  if (problems.length > 0) {
    throw new BuildError(problems.join('\n'));
  }

  const versions = new Map(
    manifest.provides.flatMap((entry) => {
      const contract = parseContractEntry(entry);

      return contract === undefined
        ? []
        : [[contract.id, contract.spec] as const];
    }),
  );
  const documents = new Map<string, JsonObject>();
  const entries: DescriptorEntry[] = [];

  for (const contract of recorded) {
    const { document, local } = contractDocument(contract);
    const previous = documents.get(contract.id);

    if (previous !== undefined && !jsonEqual(previous, document)) {
      throw new BuildError(
        `${contract.id} has different schemas in different environments.`,
      );
    }

    documents.set(contract.id, document);
    entries.push({
      id: contract.id,
      version: versions.get(contract.id) as string,
      kind: contract.kind,
      environment: contract.environment,
      cardinality: contract.cardinality,
      local,
      schema: schemaPath(contract.id),
    });
  }

  const descriptor = descriptorSchema.parse({
    descriptorVersion: 1,
    bundle: { id: manifest.id, version: manifest.version },
    contracts: entries,
  });

  for (const [id, document] of documents) {
    const target = join(dist, ...schemaPath(id).split('/'));

    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, json(document));
  }

  await writeFile(join(dist, 'contracts.json'), json(descriptor));
  await writeFile(join(dist, 'package.json'), json({ type: 'module' }));

  return { manifest, descriptor, documents };
};

/** `stage <dest> <bundleDir...>`: replaces `<dest>/<id>` with each bundle's dist. */
export const stageBundles = async (
  destination: string,
  bundleDirs: readonly string[],
): Promise<void> => {
  const target = resolve(destination);

  await mkdir(target, { recursive: true });

  for (const bundleDir of bundleDirs) {
    const dist = join(resolve(bundleDir), 'dist');
    const manifest = manifestV1Schema.parse(
      await readJson(join(dist, 'manifest.json')),
    );
    const staged = join(target, manifest.id);

    await rm(staged, { recursive: true, force: true });
    await cp(dist, staged, {
      recursive: true,
      filter: (path) => !path.endsWith('.tsbuildinfo'),
    });
  }
};

const usage =
  'Usage: cli.js build [--development] <bundleDir> | stage <dest> <bundleDir...> | copy-md <from> <to>';

/**
 * Runs one CLI command: `build [--development] <bundleDir>`,
 * `stage <dest> <bundleDir...>` or `copy-md <from> <to>` (copyMarkdown).
 * Rejects with a BuildError carrying `usage` for any other arguments, and
 * with the command's own error when it fails.
 */
export const runCli = async (args: readonly string[]): Promise<void> => {
  const [command, ...rest] = args;

  if (command === 'build' && rest.length === 1) {
    await buildBundle(rest[0] as string);
  } else if (
    command === 'build' &&
    rest.length === 2 &&
    rest[0] === '--development'
  ) {
    await buildBundle(rest[1] as string, { mode: 'development' });
  } else if (command === 'stage' && rest.length >= 2) {
    await stageBundles(rest[0] as string, rest.slice(1));
  } else if (command === 'copy-md' && rest.length === 2) {
    await copyMarkdown(rest[0] as string, rest[1] as string);
  } else {
    throw new BuildError(usage);
  }
};

const here = fileURLToPath(import.meta.url);

if (process.argv[1] !== undefined && resolve(process.argv[1]) === here) {
  try {
    await runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
