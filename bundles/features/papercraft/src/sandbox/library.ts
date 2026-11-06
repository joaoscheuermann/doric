// The runner's library job (D10, D11, D12, D14): walks up to the library
// root, answers `unchanged` when the previous manifest still holds, else
// evaluates the schemas for their signatures in a worker and bundles the
// library module. The worker is this same runner file, started again with
// `workerData` (`main.ts`). Git's ignore rules for the schemas are checked
// alongside (D8's `ignoredBy`).

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, posix, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parentPort, Worker } from 'node:worker_threads';

import * as langCore from '@openuidev/lang-core';
import * as zod from 'zod';
import * as zodCore from 'zod/v4/core';

import {
  bundleModule,
  EVALUATE_GLOBAL,
  type SourceReader,
  sourceCache,
} from '../host/bundle.js';
import { findHarness } from '../host/harness.js';
import type {
  LibraryComponent,
  LibraryOutput,
  LibraryRunnerInput,
  Manifest,
} from './protocol.js';
import type { RunnerEsbuild } from './run.js';
import { BUILTIN_COMPONENT_NAMES, SHIM_ABI, SHIM_NAMES } from './shim-names.js';
import { createStubs, StubReadError } from './stubs.js';

/** Where a library lives under its root (D8, D11). */
export const SCHEMAS_DIR = '.doric/papercraft/schemas';

/** D11's limits. */
export const MAX_ENTRIES = 100;
export const MAX_ENTRY_BYTES = 16 * 1024;
export const MAX_SCHEMAS_BYTES = 1_048_576;

/** D12: how long the evaluation may run. */
export const EVALUATE_TIMEOUT_MS = 10_000;

/** The global the frame entry publishes its namespaces under (D13). */
export const FRAME_GLOBAL = 'doric.papercraft.openui';

const MAX_ERROR = 4_096;

const ENTRY_FILE = /\.(?:tsx|ts|jsx|js)$/;

/** Names lang-core takes as calls of its own (D11), besides its built-ins. */
const RESERVED_CALLS = ['Action', 'Query', 'Mutation', 'AskForm'];

/** Which namespace serves each shimmed specifier (D13). */
const SHIMMED: Readonly<Record<string, keyof typeof SHIM_NAMES>> = {
  '@openuidev/react-lang': 'reactLang',
  '@openuidev/lang-core': 'langCore',
  zod: 'zod',
  'zod/v4': 'zod',
  'zod/v4/core': 'zodCore',
};

/** The generated shim modules over the namespaces at `global` (D13). */
export const shimModules = (global: string): Record<string, string> =>
  Object.fromEntries(
    Object.entries(SHIMMED).map(([specifier, ns]) => [
      specifier,
      [
        `const ns = globalThis[Symbol.for(${JSON.stringify(global)})].${ns};`,
        ...SHIM_NAMES[ns].map(
          (name, index) =>
            `const _${String(index)} = ns[${JSON.stringify(name)}];\nexport { _${String(index)} as ${name} };`,
        ),
      ].join('\n'),
    ]),
  );

const sha256 = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');

const missing = new Set(['ENOENT', 'ENOTDIR', 'EISDIR']);

const isMissing = (error: unknown): boolean =>
  missing.has((error as { code?: string }).code ?? '');

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** A Project directory path: `.` is the workspace root. */
const under = (dir: string, path: string): string =>
  dir === '.' ? path : `${dir}/${path}`;

/** The hashes of what one job read, keyed by Project path. */
const hashingDisk = (root: string) => {
  const hashes = new Map<string, string | null>();

  const read: SourceReader = async (path) => {
    try {
      const bytes = await readFile(join(root, path));
      hashes.set(path, sha256(bytes));

      return bytes.toString('utf8');
    } catch (error) {
      if (!isMissing(error)) throw error;
      hashes.set(path, null);

      return undefined;
    }
  };

  /** The names in `dir`, sorted; hashed under `<dir>/`. */
  const list = async (dir: string): Promise<readonly string[] | undefined> => {
    const names = await listNames(root, dir);
    hashes.set(
      `${dir}/`,
      names === undefined ? null : sha256(names.join('\n')),
    );

    return names;
  };

  return { read, list, manifest: (): Manifest => Object.fromEntries(hashes) };
};

const listNames = async (
  root: string,
  dir: string,
): Promise<readonly string[] | undefined> => {
  try {
    return (await readdir(join(root, dir))).sort();
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
};

/** The current hash of one manifest path, as `hashingDisk` wrote it. */
const currentHash = async (
  root: string,
  path: string,
): Promise<string | null> => {
  if (path.endsWith('/')) {
    const names = await listNames(root, path.slice(0, -1));

    return names === undefined ? null : sha256(names.join('\n'));
  }

  try {
    return sha256(await readFile(join(root, path)));
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
};

/** How long `git check-ignore` may take before the job goes on without it (D8). */
export const IGNORE_CHECK_TIMEOUT_MS = 5_000;

/**
 * D8: the rule of `git check-ignore -v` that hides `file` (relative to `dir`),
 * as `<source>:<line>`; `undefined` when none does, Git is missing, or it did
 * not answer within 5 s.
 */
const ignoredByOf = (dir: string, file: string): Promise<string | undefined> =>
  new Promise((done) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(value);
    };
    const child = execFile(
      'git',
      ['check-ignore', '-v', '--', file],
      { cwd: dir },
      (_error, stdout) => {
        const match = /^(.*):(\d+):[^\t]*\t/u.exec(String(stdout));
        finish(match === null ? undefined : `${match[1]}:${match[2]}`);
      },
    );
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(undefined);
    }, IGNORE_CHECK_TIMEOUT_MS);
    child.on('error', () => finish(undefined));
  });

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

/** The entry files directly in `schemas`, in file-name order (D11). */
const entriesIn = async (
  root: string,
  schemas: string,
): Promise<readonly string[]> => {
  try {
    const dirents = await readdir(join(root, schemas), { withFileTypes: true });

    return dirents
      .filter((entry) => entry.isFile() && ENTRY_FILE.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
};

/**
 * D10's walk: from `cwd` up to the first directory with entry files in
 * `schemas/`, stopping after the nearest repository root, else at the
 * workspace root. Answers the root's Project path, or `undefined`.
 */
const findRoot = async (
  root: string,
  cwd: string,
): Promise<string | undefined> => {
  for (let dir = cwd; ; dir = posix.dirname(dir)) {
    if ((await entriesIn(root, under(dir, SCHEMAS_DIR))).length > 0) return dir;
    if (dir === '.' || (await exists(join(root, dir, '.git'))))
      return undefined;
  }
};

/** The total size of the files under `dir`, recursively. */
const sizeOf = async (root: string, dir: string): Promise<number> => {
  let total = 0;

  for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) total += await sizeOf(root, path);
    else if (entry.isFile()) total += (await stat(join(root, path))).size;
  }

  return total;
};

/** D11's limits: an error naming the one exceeded, or `undefined`. */
const overLimit = async (
  root: string,
  schemas: string,
  entries: readonly string[],
): Promise<string | undefined> => {
  if (entries.length > MAX_ENTRIES) {
    return `The library has ${String(entries.length)} entry files in ${schemas}; at most ${String(MAX_ENTRIES)}.`;
  }

  for (const entry of entries) {
    const { size } = await stat(join(root, schemas, entry));

    if (size > MAX_ENTRY_BYTES) {
      return `${schemas}/${entry} is ${String(size)} bytes; an entry file is at most 16 KiB.`;
    }
  }

  const total = await sizeOf(root, schemas);

  return total > MAX_SCHEMAS_BYTES
    ? `${schemas} holds ${String(total)} bytes; at most 1 MiB.`
    : undefined;
};

/* The evaluation (D12) ----------------------------------------------------- */

/** What the worker found for one entry file. */
interface Evaluated extends LibraryComponent {
  /** The export of the entry file that holds the component. */
  readonly exportName: string;
}

type WorkerAnswer =
  | { readonly components: readonly Evaluated[] }
  | { readonly error: string };

/** The schema values reachable from a props schema's definition. */
const findStub = (
  schema: unknown,
  isStub: (value: unknown) => boolean,
): unknown => {
  const seen = new Set<unknown>();

  const visit = (value: unknown): unknown => {
    if (isStub(value)) return value;
    if (typeof value !== 'object' || value === null || seen.has(value)) {
      return undefined;
    }

    seen.add(value);

    const inner = (value as { _zod?: { def?: unknown } })._zod;
    const next =
      inner?.def !== undefined
        ? Object.values(inner.def as object)
        : Array.isArray(value) ||
            Object.getPrototypeOf(value) === Object.prototype
          ? Object.values(value)
          : [];

    for (const item of next) {
      const found = visit(item);
      if (found !== undefined) return found;
    }

    return undefined;
  };

  return visit(schema);
};

/** Whether lang-core parses `<name>()` as one of its own calls (D11). */
const isLangCall = (name: string): boolean => {
  const [statement] = langCore.split(langCore.tokenize(`a = ${name}()`));

  return (
    statement !== undefined &&
    (langCore.parseExpression(statement.tokens) as { k?: string }).k === 'Ref'
  );
};

const builtins = new Set(BUILTIN_COMPONENT_NAMES);

/** D11's name rules over the evaluated components: an error, or none. */
const nameError = (components: readonly Evaluated[]): string | undefined => {
  const seen = new Map<string, string>();

  for (const { name, file } of components) {
    if (
      builtins.has(name) ||
      RESERVED_CALLS.includes(name) ||
      isLangCall(name)
    ) {
      return `The component name \`${name}\` is declared by ${file} and by a built-in of papercraft fences.`;
    }

    const other = seen.get(name);
    if (other !== undefined) {
      return `The component name \`${name}\` is declared by ${other} and by ${file}.`;
    }

    seen.set(name, file);
  }

  return undefined;
};

/**
 * Runs in the worker: evaluates `evaluate.mjs`, whose `entries` are each
 * entry file's namespace, and posts each component's signature (D12).
 */
export const evaluateInWorker = async (data: {
  readonly evaluate: string;
}): Promise<void> => {
  const answer = async (): Promise<WorkerAnswer> => {
    const stubs = createStubs();
    const defined = new WeakSet<object>();
    const inert = (): null => null;
    const reactLang = Object.fromEntries(
      SHIM_NAMES.reactLang.map((name) => [
        name,
        (langCore as Record<string, unknown>)[name] ?? inert,
      ]),
    );

    reactLang.defineComponent = (
      config: Parameters<typeof langCore.defineComponent>[0],
    ) => {
      const result = langCore.defineComponent(config);
      defined.add(result);

      return result;
    };
    reactLang.reactive = (schema: object) => {
      langCore.markReactive(schema);

      return schema;
    };

    (globalThis as Record<symbol, unknown>)[Symbol.for(EVALUATE_GLOBAL)] = {
      langCore,
      zod,
      zodCore,
      reactLang,
      stub: stubs.module,
    };

    let module: { readonly entries: readonly (readonly [string, object])[] };

    try {
      module = (await import(
        pathToFileURL(data.evaluate).href
      )) as typeof module;
    } catch (error) {
      return { error: messageOf(error) };
    }

    const components: Evaluated[] = [];
    const definitions: ReturnType<typeof langCore.defineComponent>[] = [];

    for (const [file, namespace] of module.entries) {
      const found = Object.entries(namespace).filter(
        ([, value]) =>
          typeof value === 'object' && value !== null && defined.has(value),
      ) as [string, ReturnType<typeof langCore.defineComponent>][];
      const base = posix.basename(file).replace(ENTRY_FILE, '');

      if (found.length !== 1) {
        return {
          error: `${file} exports ${found.length === 0 ? 'no' : String(found.length)} defineComponent results; an entry file declares exactly one.`,
        };
      }

      const [[exportName, definition]] = found as [
        [string, ReturnType<typeof langCore.defineComponent>],
      ];

      if (definition.name !== base) {
        return {
          error: `${file} declares \`${definition.name}\`; its component must be named \`${base}\`, after the file.`,
        };
      }

      const stub = findStub(definition.props, stubs.isStub);
      if (stub !== undefined) {
        const read = stubs.describe(stub);

        return {
          error:
            read === undefined
              ? `${file}: the schema reads a value from outside schemas/.`
              : `${file}: ${read.message.slice(read.message.indexOf(': ') + 2)}`,
        };
      }

      definitions.push(definition);
      components.push({
        name: definition.name,
        description: definition.description ?? '',
        signature: '',
        file,
        exportName,
      });
    }

    const invalid = nameError(components);
    if (invalid !== undefined) return { error: invalid };

    const spec = langCore.createLibrary({ components: definitions }).toSpec();

    return {
      components: components.map((component) => ({
        ...component,
        signature: spec.components[component.name]?.signature ?? '',
      })),
    };
  };

  const posted = await answer().catch(
    (error: unknown): WorkerAnswer => ({
      error: error instanceof StubReadError ? error.message : messageOf(error),
    }),
  );

  parentPort?.postMessage(posted);
};

/** Starts the worker on `evaluate` and waits at most 10 s for its answer. */
const evaluate = (self: string, path: string): Promise<WorkerAnswer> =>
  new Promise((done) => {
    const worker = new Worker(self, { workerData: { evaluate: path } });
    // A timer counts from the event loop's cached time, which a busy turn
    // leaves behind: the deadline is checked against the clock itself.
    const deadline = Date.now() + EVALUATE_TIMEOUT_MS;
    const expire = (): void => {
      const left = deadline - Date.now();

      if (left > 0) {
        timer = setTimeout(expire, left);
        return;
      }

      void worker.terminate();
      done({ error: 'Evaluating the schemas did not finish in 10 s' });
    };
    let timer = setTimeout(expire, EVALUATE_TIMEOUT_MS);
    const finish = (answer: WorkerAnswer) => {
      clearTimeout(timer);
      void worker.terminate();
      done(answer);
    };

    worker.once('message', (answer: WorkerAnswer) => finish(answer));
    worker.once('error', (error) => finish({ error: messageOf(error) }));
    worker.once('exit', (code) =>
      finish({ error: `The evaluation exited with ${String(code)}` }),
    );
  });

/* The module (D11, D15) ---------------------------------------------------- */

const importPath = (path: string): string => JSON.stringify(`/${path}`);

/** The evaluation's entry: each entry file's namespace, by file. */
const evaluationEntry = (files: readonly string[]): string =>
  [
    ...files.map(
      (file, index) =>
        `import * as E${String(index)} from ${importPath(file)};`,
    ),
    `export const entries = [${files.map((file, index) => `[${JSON.stringify(file)}, E${String(index)}]`).join(', ')}];`,
  ].join('\n');

/** The library module's entry: `components`, `papercraftAbi`, `Harness`. */
const moduleEntry = (
  components: readonly Evaluated[],
  harness: boolean,
): string =>
  [
    ...components.map(
      (component, index) =>
        `import { ${component.exportName} as C${String(index)} } from ${importPath(component.file)};`,
    ),
    `export const components = [${components.map((_, index) => `C${String(index)}`).join(', ')}];`,
    `export const papercraftAbi = ${JSON.stringify(SHIM_ABI)};`,
    ...(harness ? [HARNESS_ENTRY] : []),
  ].join('\n');

/**
 * D15, minimal: the harness's decorators applied once around `children`,
 * first decorator innermost, for the `theme` given.
 */
const HARNESS_ENTRY = `import { createElement, useMemo, useRef } from 'react';
import * as HarnessModule from 'papercraft:harness';
const list = (value) => (value == null ? [] : Array.isArray(value) ? value : [value]);
const preview = HarnessModule.default && typeof HarnessModule.default === 'object' ? HarnessModule.default : {};
const decorators = [...list(preview.decorators), ...list(HarnessModule.decorators)];
const parameters = { ...(preview.parameters || {}), ...(HarnessModule.parameters || {}) };
export function Harness({ theme, children }) {
  const current = useRef(children);
  current.current = children;
  const Root = useMemo(() => {
    const context = { args: {}, globals: { theme }, parameters, viewMode: 'story', loaded: {} };
    let Inner = function HarnessChildren() { return current.current; };
    for (const decorator of decorators) {
      if (typeof decorator !== 'function') continue;
      const Story = Inner;
      Inner = function HarnessDecorator() { return decorator(Story, context); };
    }
    return Inner;
  }, [theme]);
  return createElement(Root);
}`;

/** Runs one library job in the workspace at `options.root`. */
export const runLibrary = async (
  input: LibraryRunnerInput,
  options: {
    readonly root: string;
    /** The job folder: the evaluation bundle is written there. */
    readonly jobDir: string;
    /** This runner's own file, which the worker runs again. */
    readonly self: string;
    readonly loadEsbuild: (path: string) => Promise<RunnerEsbuild>;
  },
): Promise<LibraryOutput> => {
  let esbuild: RunnerEsbuild;

  try {
    esbuild = await options.loadEsbuild(input.esbuild);
  } catch (error) {
    return {
      status: 'unavailable',
      reason: `esbuild could not be loaded from "${input.esbuild}": ${messageOf(error)}`,
    };
  }

  if (esbuild.version !== input.version) {
    return {
      status: 'unavailable',
      reason: `the sandbox has esbuild ${esbuild.version}, the host ${input.version}`,
    };
  }

  const workspace = options.root;
  const absolute = resolve(workspace, input.cwd);
  const cwd = relative(workspace, absolute) || '.';
  const disk = hashingDisk(workspace);

  if (cwd.startsWith('..') || isAbsolute(cwd) || !(await exists(absolute))) {
    return {
      status: 'failed',
      error: `The working directory ${input.cwd} no longer exists`,
      manifest: {},
    };
  }

  const found = await findRoot(workspace, cwd.split('\\').join('/'));
  if (found === undefined) return { status: 'none' };

  const root = found === '.' ? workspace : join(workspace, found);
  const previous = input.previous;

  // D14 step 2: the root is the previous one and nothing it read changed.
  if (previous !== undefined && previous.root === root) {
    let same = true;

    for (const [path, hash] of Object.entries(previous.manifest)) {
      if ((await currentHash(workspace, path)) !== hash) {
        same = false;
        break;
      }
    }

    if (same) return { status: 'unchanged', root };
  }

  const schemas = under(found, SCHEMAS_DIR);
  let entries: readonly string[] = [];
  let ignoredBy: string | undefined;

  try {
    await disk.list(schemas);
    const names = await entriesIn(workspace, schemas);
    const files = names.map((name) => `${schemas}/${name}`);
    entries = files;

    const [first] = names;
    if (first !== undefined) {
      ignoredBy = await ignoredByOf(root, `${SCHEMAS_DIR}/${first}`);
    }

    const limit = await overLimit(workspace, schemas, names);
    if (limit !== undefined) throw new Error(limit);

    const read = sourceCache(disk.read, false);
    const unserved = new Set(input.windowUnserved);
    const windowServes = (specifier: string) =>
      Promise.resolve(!unserved.has(specifier));
    const base = files[0] ?? `${schemas}/index.ts`;

    // D12: the evaluation bundle, with every import outside schemas/ stubbed.
    const evaluation = await bundleModule({
      read,
      build: esbuild.build,
      code: evaluationEntry(files),
      base,
      windowServes,
      shims: shimModules(EVALUATE_GLOBAL),
      stubOutside: schemas,
      platform: 'node',
    });
    const evaluatePath = join(options.jobDir, 'evaluate.mjs');
    await writeFile(evaluatePath, evaluation.js);

    const evaluated = await evaluate(options.self, evaluatePath);
    if ('error' in evaluated) throw new Error(evaluated.error);

    // D15: the harness, alone first, for its global CSS; one that does not
    // compile is left out with a warning.
    const warnings: string[] = [];
    let harnessPath = await findHarness(read, base, (dir) =>
      exists(join(workspace, dir, '.git')),
    );
    let globalCss: readonly string[] = [];

    if (harnessPath !== undefined) {
      try {
        globalCss = (
          await bundleModule({
            read,
            build: esbuild.build,
            code: "import * as Harness from 'papercraft:harness';\nexport default Harness;",
            base,
            harnessPath,
            windowServes,
          })
        ).css;
      } catch (error) {
        warnings.push(
          `The harness "${harnessPath}" was not applied: ${messageOf(error)}`,
        );
        harnessPath = undefined;
      }
    }

    const module = await bundleModule({
      read,
      build: esbuild.build,
      code: moduleEntry(evaluated.components, harnessPath !== undefined),
      base,
      ...(harnessPath === undefined ? {} : { harnessPath }),
      windowServes,
      shims: shimModules(FRAME_GLOBAL),
    });
    const componentCss = module.css.filter((path) => !globalCss.includes(path));
    const styles: Record<string, string> = {};

    for (const path of [...globalCss, ...componentCss]) {
      const content = await read(path);
      if (content !== undefined) styles[path] = content;
    }

    return {
      status: 'built',
      root,
      js: module.js,
      ...(harnessPath === undefined ? {} : { harness: harnessPath }),
      components: evaluated.components.map(
        ({ name, description, signature, file }) => ({
          name,
          description,
          signature,
          file,
        }),
      ),
      sources: Object.fromEntries(module.sources),
      globalCss: [...globalCss],
      componentCss,
      styles,
      windowSpecifiers: [...module.windowSpecifiers],
      hostSpecifiers: [...module.hostSpecifiers],
      warnings,
      manifest: disk.manifest(),
      ...(ignoredBy === undefined ? {} : { ignoredBy }),
    };
  } catch (error) {
    return {
      status: 'failed',
      root,
      error: messageOf(error).slice(0, MAX_ERROR),
      entries: entries.length,
      manifest: disk.manifest(),
      ...(ignoredBy === undefined ? {} : { ignoredBy }),
    };
  }
};
