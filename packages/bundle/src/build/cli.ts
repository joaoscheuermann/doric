import {
  copyFile,
  cp,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { DescFile } from '@bufbuild/protobuf';
import type { CallExpression, Node } from 'typescript';

import type { Activate } from '../contracts/context.js';
import type { Environment } from '../contracts/ids.js';
import { SkillSchema } from '../contracts/skill.js';
import type { JsonObject } from '../contracts/types.js';
import { discoverSkills, readSkill } from '../loader/skills.js';
import {
  type CatalogIndex,
  createCatalogIndex,
} from '../platform/catalog-index.js';
import { descriptorSetBytes } from '../platform/descriptor-set.js';
import type { Descriptor, DescriptorEntry } from '../runtime/descriptor.js';
import { descriptorSchema } from '../runtime/descriptor.js';
import { jsonEqual } from '../runtime/json-schema.js';
import {
  type Manifest,
  manifestV1Schema,
  manifestV2Schema,
  parseContractEntry,
  parseManifest,
} from '../runtime/manifest.js';
import { installDomShim } from './dom-shim.js';
import { hostProvides } from './host-provides.js';
import { checkRecording, recordActivation } from './record.js';
import {
  contractDocument,
  type RecordedContract,
  schemaPath,
} from './schemas.js';

/**
 * The codes of the build failures a caller tells apart (spec
 * `docs/designs/grpc-processes.md`, "The environment rule"):
 * `contract_environment` is a part that provides a contract of the other
 * environment or registers one of its handler services (A62);
 * `services_not_static` is a host part whose `services` list the build cannot
 * read without running the part (A63). The set is closed; a failure without a
 * code is any other build failure.
 */
export type BuildErrorCode = 'contract_environment' | 'services_not_static';

/**
 * A build failure. `message` is for a person; `code` is set for the failures
 * of {@link BuildErrorCode} and is `undefined` for every other one, so the
 * existing `new BuildError(message)` calls keep their meaning.
 */
export class BuildError extends Error {
  override readonly name = 'BuildError';
  readonly code: BuildErrorCode | undefined;

  constructor(message: string, code?: BuildErrorCode) {
    super(message);
    this.code = code;
  }
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
  readonly manifest: Manifest;
  readonly descriptor: Descriptor;
  readonly documents: ReadonlyMap<string, JsonObject>;
}

export interface BuildOptions {
  /** How the desktop and client parts are built (default production). */
  readonly mode?: 'production' | 'development';
}

/**
 * One entry `[Service, implementation]` of a host part's static `services`
 * list, as written in `src/host/main.ts` (A61, A63). Syntax only: the entry
 * is not resolved against an index.
 */
export interface StaticServiceEntry {
  /**
   * The `.proto` file the generated module was generated from: the module
   * specifier's path after `contracts/gen/`, its `_pb.js` replaced by
   * `.proto` (`bundle/contracts/gen/doric/tools/v1/tools_pb.js` is
   * `doric/tools/v1/tools.proto`).
   */
  readonly protoFile: string;
  /** The imported name of the service, its name in `protoFile` (`ToolHandlerService`). */
  readonly service: string;
  /** The module specifier as written (`../contracts/gen/demo/v1/demo_pb.js`). */
  readonly module: string;
  /** `<file>:<line>` of the entry, the file relative to the bundle directory. */
  readonly location: string;
}

/**
 * Reads the static `services` list of the host part in
 * `<bundleDir>/src/host/main.ts` without running it (A63), with
 * `ts.createSourceFile`; `typescript` is loaded on demand, a build-time tool
 * like esbuild.
 *
 * Resolves to the entries in source order. Resolves to `[]` when the file is
 * missing, holds no call of `runBundle`, or the call's argument has no
 * `services` property (A61: `services` is optional).
 *
 * Rejects with a {@link BuildError} of code `services_not_static`, its message
 * `<file>:<line>: <what is not static>`, when the `services` property is not
 * an array literal of array literals `[Service, implementation]`, a
 * `Service` is not an identifier imported by name (not a namespace or default
 * import) from a module whose specifier ends in `contracts/gen/<path>_pb.js`,
 * or `main.ts` calls `runBundle` more than once. Rejects with the fs error of
 * any read failure other than a missing file.
 */
export const readStaticServices = async (
  bundleDir: string,
): Promise<readonly StaticServiceEntry[]> => {
  const file = 'src/host/main.ts';
  let text: string;

  try {
    text = await readFile(join(bundleDir, ...file.split('/')), 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }

  // Loaded on demand: the TypeScript parser is a build-time tool.
  const { default: ts } = await import('typescript');
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const lineOf = (node: Node): string =>
    `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
  const notStatic = (node: Node, what: string): BuildError =>
    new BuildError(`${lineOf(node)}: ${what}`, 'services_not_static');

  const imported = new Map<
    string,
    { readonly name: string; readonly module: string } | null
  >();
  const calls: CallExpression[] = [];
  const visit = (node: Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const module = node.moduleSpecifier.text;
      const clause = node.importClause;

      if (clause?.name !== undefined) {
        imported.set(clause.name.text, null);
      }

      const bindings = clause?.namedBindings;

      if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
        imported.set(bindings.name.text, null);
      } else if (bindings !== undefined) {
        for (const element of bindings.elements) {
          imported.set(element.name.text, {
            name: (element.propertyName ?? element.name).text,
            module,
          });
        }
      }
    }

    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'runBundle'
    ) {
      calls.push(node);
    }

    ts.forEachChild(node, visit);
  };

  visit(source);

  const [call, second] = calls;

  if (second !== undefined) {
    throw notStatic(second, 'runBundle is called more than once.');
  }

  if (call === undefined) {
    return [];
  }

  const [argument] = call.arguments;

  if (argument === undefined) {
    return [];
  }

  if (!ts.isObjectLiteralExpression(argument)) {
    throw notStatic(
      argument,
      'the argument of runBundle is not an object literal.',
    );
  }

  const property = argument.properties.find(
    (entry) =>
      entry.name !== undefined &&
      ts.isIdentifier(entry.name) &&
      entry.name.text === 'services',
  );

  if (property === undefined) {
    return [];
  }

  if (
    !ts.isPropertyAssignment(property) ||
    !ts.isArrayLiteralExpression(property.initializer)
  ) {
    throw notStatic(property, 'services is not an array literal.');
  }

  return property.initializer.elements.map((element) => {
    if (!ts.isArrayLiteralExpression(element)) {
      throw notStatic(
        element,
        'a services entry is not an array literal [Service, implementation].',
      );
    }

    const [service] = element.elements;

    if (element.elements.length !== 2 || service === undefined) {
      throw notStatic(
        element,
        'a services entry is not [Service, implementation].',
      );
    }

    const binding = ts.isIdentifier(service)
      ? imported.get(service.text)
      : undefined;

    if (binding === undefined || binding === null) {
      throw notStatic(
        service,
        'a service is not an identifier imported by name.',
      );
    }

    const generated = /contracts\/gen\/(.+)_pb\.js$/.exec(binding.module);

    if (generated === null) {
      throw notStatic(
        service,
        `${binding.name} is not imported from a generated contracts/gen/<path>_pb.js module.`,
      );
    }

    return {
      protoFile: `${generated[1] as string}.proto`,
      service: binding.name,
      module: binding.module,
      location: lineOf(element),
    };
  });
};

/**
 * The catalog index the build checks a bundle against (G5): every `DescFile`
 * exported (`file_*`) by a `*_pb.js` module below `<bundleDir>/dist/contracts/gen`
 * (tsc's output of the bundle's `src/contracts/gen`, so call it after tsc),
 * below this package's own `contracts/gen` (the platform and basic
 * contracts, found relative to this module), and by the module of each entry
 * of `entries` whose specifier is a package specifier, resolved from
 * `bundleDir` as Node resolves it; each with the files it imports. A missing
 * `dist/contracts/gen` adds nothing.
 *
 * Rejects with the import error of a module that fails to load, and with the
 * `TypeError` of `createCatalogIndex` for a file the index cannot hold.
 */
export const loadBuildIndex = async (
  bundleDir: string,
  entries: readonly StaticServiceEntry[],
): Promise<CatalogIndex> => {
  const root = resolve(bundleDir);
  const resolveFrom = createRequire(join(root, 'package.json'));
  const own = fileURLToPath(new URL('../contracts/gen/', import.meta.url));
  // This package's modules are loaded through its own export, the specifier
  // generated code imports them by, so that each file is loaded once.
  const modules = [
    ...(await generatedModules(join(root, 'dist', 'contracts', 'gen'))).map(
      (path) => pathToFileURL(path).href,
    ),
    ...(await generatedModules(own)).map((path) =>
      import.meta.resolve(
        `bundle/contracts/gen/${relative(own, path).split(sep).join('/')}`,
      ),
    ),
    ...entries
      .filter(
        (entry) =>
          !entry.module.startsWith('.') && !entry.module.startsWith('/'),
      )
      .map((entry) => pathToFileURL(resolveFrom.resolve(entry.module)).href),
  ];

  return createCatalogIndex(await exportedFiles(new Set(modules)));
};

/** The `DescFile`s exported (`file_*`) by the modules `hrefs`, in order. */
const exportedFiles = async (hrefs: Iterable<string>): Promise<DescFile[]> => {
  const files: DescFile[] = [];

  for (const href of hrefs) {
    const loaded = (await import(href)) as Record<string, unknown>;

    for (const [name, value] of Object.entries(loaded)) {
      if (name.startsWith('file_') && isDescFile(value)) {
        files.push(value);
      }
    }
  }

  return files;
};

const isDescFile = (value: unknown): value is DescFile =>
  typeof value === 'object' &&
  value !== null &&
  'kind' in value &&
  value.kind === 'file';

/** The `*_pb.js` files at any depth below `dir`, sorted; none when `dir` is missing. */
const generatedModules = async (dir: string): Promise<readonly string[]> => {
  try {
    const entries = await readdir(dir, {
      recursive: true,
      withFileTypes: true,
    });

    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('_pb.js'))
      .map((entry) => join(entry.parentPath, entry.name))
      .sort();
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
};

/** One failure of {@link checkContractEnvironment}. */
export interface EnvironmentProblem {
  readonly code: BuildErrorCode;
  /** For a person; names the contract and the part, or the entry's location. */
  readonly message: string;
}

/**
 * The environment rule's build check, rule 1 (A62, A63). Answers `[]` for a
 * manifest of version 1: in phases 2 to 4 only version 2 manifests are
 * checked. For a version 2 manifest:
 *
 * - each recorded provide whose id is a contract of `index` must be provided
 *   by a part of its environment: a host part provides `HOST` and `HOOKS`
 *   contracts, a client part `CLIENT` contracts; any other pairing, a
 *   `desktopMain` recording included, is a `contract_environment` problem
 *   naming the contract and the part. A provide whose id has no `.proto` in
 *   `index` (a `define*` contract) is not checked;
 * - each entry of `services` must name a service of `index` (its
 *   `protoFile` holds a service named `service`); otherwise it is a
 *   `services_not_static` problem naming the entry's location. A named
 *   service of a contract whose environment is `CLIENT` (its own service or
 *   a handler service) is a `contract_environment` problem naming the
 *   contract, the service and the host part.
 *
 * Client parts register no generated services until phase 6, so only the
 * host part's `services` are checked. Problems come in the order of
 * `recorded`, then of `services`. The caller throws a {@link BuildError}
 * with the messages joined by newlines, of code `services_not_static` when a
 * problem has it and `contract_environment` otherwise. Never throws.
 */
export const checkContractEnvironment = (input: {
  readonly manifest: Manifest;
  readonly recorded: readonly RecordedContract[];
  readonly services: readonly StaticServiceEntry[];
  readonly index: CatalogIndex;
}): readonly EnvironmentProblem[] => {
  const { manifest, recorded, services, index } = input;

  if (manifest.manifestVersion !== 2) {
    return [];
  }

  const problems: EnvironmentProblem[] = [];

  for (const entry of recorded) {
    const contract = index.contract(entry.id);

    if (contract === undefined) {
      continue;
    }

    const allowed =
      entry.environment === 'host'
        ? contract.environment === 'HOST' || contract.environment === 'HOOKS'
        : entry.environment === 'client' && contract.environment === 'CLIENT';

    if (!allowed) {
      problems.push({
        code: 'contract_environment',
        message: `${entry.id} is a ${contract.environment} contract; the ${entry.environment} part may not provide it.`,
      });
    }
  }

  for (const entry of services) {
    const descriptor = index.registry
      .getFile(entry.protoFile)
      ?.services.find((candidate) => candidate.name === entry.service);
    const info =
      descriptor === undefined ? undefined : index.service(descriptor.typeName);

    if (info === undefined) {
      problems.push({
        code: 'services_not_static',
        message: `${entry.location}: ${entry.service} is not a contract service of ${entry.protoFile}.`,
      });
    } else if (info.contract.environment === 'CLIENT') {
      problems.push({
        code: 'contract_environment',
        message: `${entry.location}: ${entry.service} belongs to the CLIENT contract ${info.contract.id}; the host part may not register it.`,
      });
    }
  }

  return problems;
};

/**
 * `build <bundleDir>` (after tsc): validates the v1 manifest, copies skills
 * and the host part's Markdown templates (every `.md` file below `src/host`,
 * which the host part reads at import time, so before the dry activation),
 * builds the desktop and client parts, dry-activates the parts, writes JSON
 * Schemas, `contracts.json` and package.json. The semver check against a
 * published baseline is not here yet: it returns with publishing (stage 11).
 *
 * Host part (spec §14 step 1): `dist/host/main.mjs` is deleted first, so a
 * bundle whose `src/host/main.ts` was removed leaves no stale file; after the
 * desktop and client parts and the version 2 environment check (so the cheap
 * static checks of the source come first), `buildHostPart` (host.ts) builds
 * it again when `src/host/main.ts` exists. A HostBuildError rejects as a
 * BuildError with the same message.
 *
 * Descriptors (spec §8): every build writes `dist/descriptors.binpb`, the
 * binary `google.protobuf.FileDescriptorSet` of the bundle's own `.proto`
 * files (the generated `DescFile`s, `file_*` exports, of the `*_pb.js`
 * modules below `<bundleDir>/dist/contracts/gen`, the modules
 * {@link loadBuildIndex} loads first) and every file they import,
 * transitively, each once, imports first. A bundle without
 * `dist/contracts/gen` writes an empty set (zero bytes). The file is deleted
 * first, so a failed build leaves no stale one. `contracts.json` is still
 * written until phase 6.
 *
 * Host provides (A61, A63, A70): after the dry activation the build reads
 * the host part's static `services` and the build index, and
 * {@link hostProvides} answers what the host part provides beyond the
 * recording. They count in `checkRecording`: a served contract `provides`
 * does not list fails the build, in any manifest version. Each one
 * `provides` declares gets a `host` entry in `contracts.json` after the
 * recorded entries, with the declared version, its kind and cardinality,
 * `local: false` and the path `schemas/<id>.json`, where no document is
 * written: a reader treats the missing document as a contract with no JSON
 * Schema and no `x-doric-expose` (the desktop leaves it unrouted). Its
 * exposure is its `.proto`'s, which the gateway reads from
 * `descriptors.binpb`. A contract the desktopMain part records gets no host
 * entry, in any manifest version.
 */
export const buildBundle = async (
  bundleDir: string,
  options: BuildOptions = {},
): Promise<BuildResult> => {
  const root = resolve(bundleDir);
  const dist = join(root, 'dist');
  const manifestPath = join(root, 'manifest.json');
  const document = await readJson(manifestPath);
  const parsed =
    typeof document === 'object' &&
    document !== null &&
    'manifestVersion' in document &&
    document.manifestVersion === 2
      ? manifestV2Schema.safeParse(document)
      : manifestV1Schema.safeParse(document);

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
    'descriptors.binpb',
    'manifest.json',
  ]) {
    await rm(join(dist, generated), { recursive: true, force: true });
  }

  await rm(join(dist, 'host', 'main.mjs'), { force: true });

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

  const services = await readStaticServices(root);
  const index = await loadBuildIndex(root, services);
  const served = hostProvides({ manifest, recorded, services, index });
  const problems = checkRecording(manifest, recorded, served);

  if (problems.length > 0) {
    throw new BuildError(problems.join('\n'));
  }

  const environmentProblems = checkContractEnvironment({
    manifest,
    recorded,
    services,
    index,
  });

  if (environmentProblems.length > 0) {
    throw new BuildError(
      environmentProblems.map((problem) => problem.message).join('\n'),
      environmentProblems.some(
        (problem) => problem.code === 'services_not_static',
      )
        ? 'services_not_static'
        : 'contract_environment',
    );
  }

  const { buildHostPart } = await import('./host.js');

  try {
    await buildHostPart({ bundleDir: root });
  } catch (error) {
    throw new BuildError(messageOf(error));
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

  for (const contract of served) {
    if (contract.declared === undefined) {
      continue;
    }

    entries.push({
      id: contract.id,
      version: contract.declared,
      kind: contract.kind,
      environment: 'host',
      cardinality: contract.cardinality,
      local: false,
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

  await writeFile(
    join(dist, 'descriptors.binpb'),
    descriptorSetBytes(
      await exportedFiles(
        (await generatedModules(join(root, 'dist', 'contracts', 'gen'))).map(
          (path) => pathToFileURL(path).href,
        ),
      ),
    ),
  );
  await writeFile(join(dist, 'contracts.json'), json(descriptor));
  await writeFile(join(dist, 'package.json'), json({ type: 'module' }));

  return { manifest, descriptor, documents };
};

/**
 * The bundle directories below `root`: every `<root>/<group>/<id>` that holds
 * a `manifest.json`, sorted by path in code-unit order. Files, and
 * directories without a manifest such as `node_modules`, are skipped.
 */
export const bundleDirectories = async (
  root: string,
): Promise<readonly string[]> => {
  const found: string[] = [];

  for (const group of await readdir(root, { withFileTypes: true })) {
    if (!group.isDirectory()) {
      continue;
    }

    const groupDir = join(root, group.name);

    for (const entry of await readdir(groupDir, { withFileTypes: true })) {
      const dir = join(groupDir, entry.name);

      if (entry.isDirectory() && (await exists(join(dir, 'manifest.json')))) {
        found.push(dir);
      }
    }
  }

  return found.sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
};

export interface StageOptions {
  /**
   * Stage for development: after copying, every bundle whose
   * `<bundleDir>/dist/host/main.mjs` exists also gets
   * `<dest>/<id>/host/command.json`, a JSON array
   * `["node", "<absolute bundleDir>/dist/host/main.mjs"]` (default false).
   */
  readonly dev?: boolean;
}

/**
 * `stage [--dev] <dest> <bundleDir...>`: replaces `<dest>/<id>` with each
 * bundle's dist; with `options.dev`, also writes each built host part's
 * `host/command.json` (StageOptions.dev). Rejects with a BuildError naming
 * the bundle directory when its `dist/manifest.json` is missing.
 *
 * The staged `<id>` is read by `manifestVersion` with `parseManifest`
 * (`runtime/manifest.ts`), so a version 1 or 2 manifest stages; rejects with
 * `parseManifest`'s error on an invalid manifest.
 */
export const stageBundles = async (
  destination: string,
  bundleDirs: readonly string[],
  options: StageOptions = {},
): Promise<void> => {
  const target = resolve(destination);

  await mkdir(target, { recursive: true });

  for (const bundleDir of bundleDirs) {
    const dist = join(resolve(bundleDir), 'dist');
    const manifestPath = join(dist, 'manifest.json');

    if (!(await exists(manifestPath))) {
      throw new BuildError(
        `${bundleDir}: dist/manifest.json is missing; build the bundle first`,
      );
    }

    const { manifest } = parseManifest(await readJson(manifestPath));
    const staged = join(target, manifest.id);

    await rm(staged, { recursive: true, force: true });
    await cp(dist, staged, {
      recursive: true,
      filter: (path) => !path.endsWith('.tsbuildinfo'),
    });

    const main = join(dist, 'host', 'main.mjs');

    if (options.dev === true && (await exists(main))) {
      await mkdir(join(staged, 'host'), { recursive: true });
      await writeFile(
        join(staged, 'host', 'command.json'),
        json(['node', main]),
      );
    }
  }
};

const usage =
  'Usage: cli.js build [--development] <bundleDir> | stage [--dev] <dest> <bundleDir...> | stage [--dev] <dest> --all <root> | copy-md <from> <to>';

/**
 * Runs one CLI command: `build [--development] <bundleDir>`,
 * `stage [--dev] <dest> <bundleDir...>`, `stage [--dev] <dest> --all <root>`
 * (every bundle directory `<root>/<group>/<id>` with a `manifest.json`;
 * `--dev` sets StageOptions.dev) or `copy-md <from> <to>`
 * (copyMarkdown).
 * Rejects with a BuildError carrying `usage` for any other arguments, and
 * with the command's own error when it fails.
 */
export const runCli = async (args: readonly string[]): Promise<void> => {
  const [command, ...afterCommand] = args;
  const dev = command === 'stage' && afterCommand[0] === '--dev';
  const rest = dev ? afterCommand.slice(1) : afterCommand;

  if (command === 'build' && rest.length === 1) {
    await buildBundle(rest[0] as string);
  } else if (
    command === 'build' &&
    rest.length === 2 &&
    rest[0] === '--development'
  ) {
    await buildBundle(rest[1] as string, { mode: 'development' });
  } else if (command === 'stage' && rest[1] === '--all') {
    if (rest.length !== 3) {
      throw new BuildError(usage);
    }

    await stageBundles(
      rest[0] as string,
      await bundleDirectories(rest[2] as string),
      { dev },
    );
  } else if (command === 'stage' && rest.length >= 2) {
    await stageBundles(rest[0] as string, rest.slice(1), { dev });
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
