// Path B: compiles a `component` preview into a live module and its sheet.
//
// The sources live in the Project sandbox, not on the host disk, so esbuild
// reads them through a `SourceReader` (the builder hands it `files/v1`). The
// result is one ESM `index.js` that exports `mount(root, { theme })` — the
// module contract the node imports from `doric://app/artifacts/…` — and one
// `index.css` with the Tailwind the artifact's own classes need.
//
// Resolution, in order, for every import the artifact makes:
//
// 1. The window's import map: the specifiers `clientExternals` lists (React,
//    ReactDOM, `desktop/ui`, Lexical, zod) stay external and resolve in the
//    window, so the preview shares the app's one React. `bundle/contracts`
//    and `*/contracts` are not left external here: a preview is Project code,
//    not a bundle part.
// 2. Imports a preview must not make — `bundle`, `desktop` outside
//    `desktop/ui`, Node built-ins — fail the build with a message naming them.
// 3. Relative imports and the Project's `tsconfig.json` `paths` aliases are
//    read from the sandbox: `./x.js` tries the TypeScript twins first
//    (`x.ts`, `x.tsx`), an extensionless import tries `.tsx/.ts/.jsx/.js`
//    and then `index.*`.
// 4. Bare packages the host itself ships for previews (`HOST_PACKAGES`, today
//    `lucide-react`) are bundled from the host's own `node_modules`: their
//    per-file layout is too many sandbox reads, and the window's import map
//    does not serve them.
// 5. Any other bare package is resolved in the Project's `node_modules`
//    through the sandbox (`exports`, then `module`, then `main`) and bundled,
//    under a read budget; a package that cannot be found or that exceeds the
//    budget fails the build, naming the import, so the agent stubs it in the
//    preview wrapper instead.
//
// The previewed source is wrapped by the Project's preview harness
// (`harness.ts`: `.storybook/preview.*` or `.papercraft/preview.*`) when it
// has one, and a CSF stories file mounts one of its stories (`entry.ts`).
// `@storybook/addon-themes` resolves to a built-in stand-in before step 3.
//
// CSS imports are not bundled into the module: they load as empty modules,
// and the build records them. The harness's are the Project's global CSS,
// the components' are appended to it; `css.ts` compiles both into
// `index.css` with the utilities of the classes in the bundled sources.
//
// JSX is compiled in development form so each element the Project's code
// writes knows its `fileName:lineNumber`; a small runtime shim turns that into
// the `data-papercraft-source="path:line"` stamp the comment anchors read, and
// otherwise defers to `react/jsx-runtime` from the import map.
//
// esbuild and the Tailwind compiler are loaded on demand: they are workspace
// tools the host image ships, and an `html` preview never pays for them.

import { isBuiltin } from 'node:module';
import { dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ContractError } from 'bundle/contracts';
import { clientExternals, matchesExternal } from 'bundle/externals';
import type {
  BuildFailure,
  BuildOptions,
  Loader,
  Message,
  Metafile,
  Plugin,
} from 'esbuild';

import { compileStyles } from './css.js';
import {
  entryModule,
  HARNESS_ID,
  isStoriesFile,
  PORTAL_CONTAINER_SPECIFIER,
  SOURCE_ID,
  storyOrder,
} from './entry.js';
import { findHarness, STORYBOOK_SHIMS } from './harness.js';
import {
  exportTarget,
  isRecord,
  isRelative,
  packageOf,
  projectPath,
} from './paths.js';

/**
 * Reads one Project file as text: `undefined` when there is no such file,
 * a thrown error when the sandbox cannot answer or the file is not text.
 */
export type SourceReader = (path: string) => Promise<string | undefined>;

/** The compiled module and sheet of one component preview. */
export interface CompiledComponent {
  /** The ESM module: `export function mount(root, { theme })`. */
  readonly js: string;
  /** The Tailwind sheet the module's classes need, for its shadow root. */
  readonly css: string;
  /** The export of the source the module mounts (a story's, for CSF). */
  readonly exportName: string;
  /** The Project harness the module applies, when it has one. */
  readonly harness?: string;
  /** What the build skipped without failing. */
  readonly warnings: readonly string[];
}

/** The most sandbox reads (hits and misses) one compile may make. */
export const MAX_SOURCE_READS = 1_500;

/** The most source bytes one compile may bundle. */
export const MAX_SOURCE_BYTES_TOTAL = 8 * 1_048_576;

/** The import-map specifiers a preview leaves to the window. */
export const previewExternals: readonly string[] = clientExternals.filter(
  (pattern) => !pattern.endsWith('/contracts'),
);

/**
 * Bare packages bundled from the host's own `node_modules` rather than the
 * sandbox: UI packages the app's own code uses that the import map does not
 * serve, whose per-file ESM layout would cost hundreds of sandbox reads.
 */
export const HOST_PACKAGES: readonly string[] = ['lucide-react'];

const SOURCE_NS = 'papercraft-source';
const ENTRY_NS = 'papercraft-entry';
const JSX_NS = 'papercraft-jsx';
const REQUIRE_NS = 'papercraft-external-require';
const SHIM_NS = 'papercraft-shim';

const ENTRY_ID = 'papercraft:entry';
const JSX_SOURCE = 'papercraft-jsx';

const SCRIPT_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js'];

/** The TypeScript twins tried before an emitted-extension import itself. */
const TWINS: Readonly<Record<string, readonly string[]>> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};

const LOADERS: Readonly<Record<string, Loader>> = {
  '.tsx': 'tsx',
  '.ts': 'ts',
  '.mts': 'ts',
  '.cts': 'ts',
  '.jsx': 'jsx',
  '.js': 'jsx',
  '.mjs': 'js',
  '.cjs': 'js',
  '.json': 'json',
  '.svg': 'dataurl',
  '.css': 'empty',
};

/** Imports a preview module must not contain. */
const forbidden = (specifier: string): string | undefined => {
  if (specifier.startsWith('node:') || isBuiltin(specifier)) {
    return `"${specifier}" is a Node built-in; a preview runs in the app window.`;
  }

  const name = packageOf(specifier);

  if (name === 'bundle') {
    return `A preview must not import "${specifier}": it is platform code, not Project code.`;
  }

  if (
    name === 'desktop' &&
    specifier !== 'desktop/ui' &&
    !specifier.startsWith('desktop/ui/')
  ) {
    return `A preview must not import "${specifier}"; only "desktop/ui" is shared with the window.`;
  }

  return undefined;
};

/** The files one import of `base` may name, in the order they are tried. */
const candidatesOf = (base: string): readonly string[] => {
  const ext = posix.extname(base);
  const twins = TWINS[ext];

  if (twins !== undefined) {
    const stem = base.slice(0, -ext.length);

    return [...twins.map((twin) => `${stem}${twin}`), base];
  }

  return [
    ...(ext !== '' && LOADERS[ext] !== undefined ? [base] : []),
    ...SCRIPT_EXTENSIONS.map((suffix) => `${base}${suffix}`),
    ...SCRIPT_EXTENSIONS.map((suffix) => `${base}/index${suffix}`),
  ];
};

const loaderOf = (path: string): Loader | undefined => {
  const loader = LOADERS[posix.extname(path)];

  // Published packages ship plain JavaScript; only the Project's own `.js`
  // files are read as JSX.
  return loader === 'jsx' && /(^|\/)node_modules\//.test(path) ? 'js' : loader;
};

/** Strips `//` and `/* *\/` comments and trailing commas from a tsconfig. */
const parseJsonc = (text: string): unknown => {
  let out = '';
  let index = 0;

  while (index < text.length) {
    const char = text[index];

    if (char === '"') {
      const start = index;
      index += 1;

      while (index < text.length && text[index] !== '"') {
        index += text[index] === '\\' ? 2 : 1;
      }

      index += 1;
      out += text.slice(start, index);
    } else if (char === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
    } else if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2);
      index = end === -1 ? text.length : end + 2;
    } else {
      out += char;
      index += 1;
    }
  }

  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
};

/** One `paths` alias of the Project's tsconfig, resolved to Project paths. */
interface PathAlias {
  readonly prefix: string;
  readonly suffix: string;
  readonly wildcard: boolean;
  readonly targets: readonly string[];
}

const describeMessages = (messages: readonly Message[]): string =>
  messages
    .map((entry) => {
      const text = entry.text.replaceAll(`${SOURCE_NS}:`, '');
      const location = entry.location;

      return location === null || location === undefined
        ? text
        : `${location.file.replace(`${SOURCE_NS}:`, '')}:${String(location.line)}:${String(location.column)}: ${text}`;
    })
    .join('\n');

const failureOf = (error: unknown): string => {
  const failure = error as Partial<BuildFailure>;

  if (Array.isArray(failure.errors) && failure.errors.length > 0) {
    return describeMessages(failure.errors);
  }

  return error instanceof Error ? error.message : String(error);
};

/** The JSX runtime shim: stamps host elements with their source line. */
const JSX_RUNTIME = `import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
export { Fragment };
const PREFIX = ${JSON.stringify(`${SOURCE_NS}:`)};
export function jsxDEV(type, props, key, isStatic, source) {
  let next = props;
  if (
    typeof type === 'string' &&
    source != null &&
    typeof source.fileName === 'string' &&
    props != null &&
    props['data-papercraft-source'] === undefined
  ) {
    const file = source.fileName.startsWith(PREFIX)
      ? source.fileName.slice(PREFIX.length)
      : source.fileName;
    next = { ...props, 'data-papercraft-source': file + ':' + source.lineNumber };
  }
  return isStatic ? jsxs(type, next, key) : jsx(type, next, key);
}
`;

/** The export a preview mounts: `entry`, else `default`, else one PascalCase export. */
export const pickExport = (
  path: string,
  exports: readonly string[],
  entry: string | undefined,
): string => {
  const listed = exports.length === 0 ? 'none' : exports.join(', ');

  if (entry !== undefined) {
    if (exports.includes(entry)) return entry;

    throw new ContractError(
      'invalid_input',
      `The component "${path}" has no export "${entry}" (exports: ${listed}).`,
      { path, entry, exports: [...exports] },
    );
  }

  if (exports.includes('default')) return 'default';

  const components = exports.filter((name) => /^[A-Z]/.test(name));

  if (components.length === 1 && components[0] !== undefined) {
    return components[0];
  }

  throw new ContractError(
    'invalid_input',
    `The component "${path}" has no default export and ${
      components.length === 0 ? 'no' : 'more than one'
    } PascalCase export (exports: ${listed}); pass \`entry\` with the export to mount.`,
    { path, exports: [...exports] },
  );
};

/** The story a CSF file mounts: `entry`, else its first story in source order. */
export const pickStory = (
  path: string,
  stories: readonly string[],
  entry: string | undefined,
): string => {
  const listed = stories.length === 0 ? 'none' : stories.join(', ');

  if (entry !== undefined) {
    if (stories.includes(entry)) return entry;

    throw new ContractError(
      'invalid_input',
      `The stories file "${path}" has no story "${entry}" (stories: ${listed}).`,
      { path, entry, stories: [...stories] },
    );
  }

  const first = stories[0];

  if (first === undefined) {
    throw new ContractError(
      'invalid_input',
      `The stories file "${path}" exports no story.`,
      { path },
    );
  }

  return first;
};

/** The reads one compile shares across its passes, under one budget. */
const sourceCache = (read: SourceReader) => {
  const cache = new Map<string, Promise<string | undefined>>();
  let reads = 0;
  let bytes = 0;

  return (path: string): Promise<string | undefined> => {
    const cached = cache.get(path);
    if (cached !== undefined) return cached;

    reads += 1;

    if (reads > MAX_SOURCE_READS) {
      return Promise.reject(
        new Error(
          `The preview reads more than ${String(MAX_SOURCE_READS)} files from the sandbox (at "${path}"); stub large dependencies in the preview wrapper.`,
        ),
      );
    }

    const pending = read(path).then((content) => {
      bytes += content === undefined ? 0 : Buffer.byteLength(content, 'utf8');

      if (bytes > MAX_SOURCE_BYTES_TOTAL) {
        throw new Error(
          `The preview bundles more than ${String(MAX_SOURCE_BYTES_TOTAL)} bytes of source (at "${path}"); stub large dependencies in the preview wrapper.`,
        );
      }

      return content;
    });

    cache.set(path, pending);

    return pending;
  };
};

/** The directory esbuild resolves `HOST_PACKAGES` from: this module's own. */
const hostResolveDir = (): string => dirname(fileURLToPath(import.meta.url));

/**
 * The esbuild plugin that reads the Project through the sandbox and keeps the
 * window's import map external. `loaded` collects the Project files the build
 * read (for the Tailwind scan), `css` the stylesheets it imported.
 */
const sandboxPlugin = (input: {
  readonly read: (path: string) => Promise<string | undefined>;
  readonly sourcePath: string;
  readonly entry?: string;
  readonly harnessPath?: string;
  readonly aliases: readonly PathAlias[];
  readonly loaded: Map<string, string>;
  /** The Project stylesheets this build imported, in import order. */
  readonly css: Set<string>;
}): Plugin => ({
  name: 'papercraft-sandbox',
  setup(context) {
    const firstExisting = async (
      candidates: readonly string[],
    ): Promise<string | undefined> => {
      for (const candidate of candidates) {
        if ((await input.read(candidate)) !== undefined) return candidate;
      }

      return undefined;
    };

    const resolvePackage = async (
      importer: string,
      specifier: string,
    ): Promise<string | undefined> => {
      const name = packageOf(specifier);
      const rest = specifier.slice(name.length);
      const subpath = rest === '' ? '.' : `.${rest}`;
      let dir = posix.dirname(importer);

      for (;;) {
        const root = dir === '.' ? 'node_modules' : `${dir}/node_modules`;
        const pkgDir = `${root}/${name}`;
        const manifestText = await input.read(`${pkgDir}/package.json`);

        if (manifestText !== undefined) {
          const manifest: unknown = JSON.parse(manifestText);
          const fields = isRecord(manifest) ? manifest : {};
          let target: string | undefined;

          if (fields.exports !== undefined) {
            target = exportTarget(fields.exports, subpath);
            if (target === undefined) return undefined;

            return firstExisting([posix.join(pkgDir, target)]);
          }

          if (subpath === '.') {
            target =
              (typeof fields.module === 'string' ? fields.module : undefined) ??
              (typeof fields.browser === 'string'
                ? fields.browser
                : undefined) ??
              (typeof fields.main === 'string' ? fields.main : undefined) ??
              'index.js';
          } else {
            target = subpath;
          }

          return firstExisting(candidatesOf(posix.join(pkgDir, target)));
        }

        if (dir === '.' || dir === '') return undefined;
        dir = posix.dirname(dir);
      }
    };

    const resolveAlias = async (
      specifier: string,
    ): Promise<string | undefined> => {
      for (const alias of input.aliases) {
        let matched: string;

        if (alias.wildcard) {
          if (
            !specifier.startsWith(alias.prefix) ||
            !specifier.endsWith(alias.suffix) ||
            specifier.length < alias.prefix.length + alias.suffix.length
          ) {
            continue;
          }

          matched = specifier.slice(
            alias.prefix.length,
            specifier.length - alias.suffix.length,
          );
        } else if (specifier === alias.prefix) {
          matched = '';
        } else {
          continue;
        }

        for (const target of alias.targets) {
          const found = await firstExisting(
            candidatesOf(target.replaceAll('*', matched)),
          );

          if (found !== undefined) return found;
        }
      }

      return undefined;
    };

    context.onResolve({ filter: /.*/ }, async (args) => {
      if (args.kind === 'entry-point') {
        return args.path === ENTRY_ID
          ? { path: ENTRY_ID, namespace: ENTRY_NS }
          : { path: args.path, namespace: SOURCE_NS };
      }

      if (args.path === SOURCE_ID && args.namespace === ENTRY_NS) {
        return { path: input.sourcePath, namespace: SOURCE_NS };
      }

      if (
        args.path === HARNESS_ID &&
        args.namespace === ENTRY_NS &&
        input.harnessPath !== undefined
      ) {
        return { path: input.harnessPath, namespace: SOURCE_NS };
      }

      if (args.path === `${JSX_SOURCE}/jsx-dev-runtime`) {
        return { path: args.path, namespace: JSX_NS };
      }

      if (matchesExternal(previewExternals, args.path)) {
        // A bundled CommonJS module that `require`s an external gets an ESM
        // re-export of it, so the external stays the window's one instance.
        return args.kind === 'require-call' && args.namespace !== REQUIRE_NS
          ? { path: args.path, namespace: REQUIRE_NS }
          : { path: args.path, external: true };
      }

      const refused = forbidden(args.path);
      if (refused !== undefined) return { errors: [{ text: refused }] };

      if (STORYBOOK_SHIMS[args.path] !== undefined) {
        return { path: args.path, namespace: SHIM_NS };
      }

      // Inside a host package: esbuild resolves it on the host disk.
      if (args.namespace === 'file') return undefined;

      if (HOST_PACKAGES.includes(packageOf(args.path))) {
        const resolved = await context.resolve(args.path, {
          kind: args.kind,
          resolveDir: hostResolveDir(),
          namespace: 'file',
        });

        return resolved.errors.length > 0
          ? { errors: resolved.errors }
          : { path: resolved.path, namespace: resolved.namespace };
      }

      const importer = args.importer;

      if (isRelative(args.path)) {
        const base = projectPath(importer, args.path);

        if (base === undefined) {
          return {
            errors: [{ text: `"${args.path}" resolves outside the Project.` }],
          };
        }

        const found = await firstExisting(candidatesOf(base));

        return found === undefined
          ? {
              errors: [
                {
                  text: `Cannot resolve "${args.path}" from "${importer}": no ${base} file in the Project.`,
                },
              ],
            }
          : { path: found, namespace: SOURCE_NS };
      }

      const aliased = await resolveAlias(args.path);
      if (aliased !== undefined) return { path: aliased, namespace: SOURCE_NS };

      const packaged = await resolvePackage(importer, args.path);

      return packaged === undefined
        ? {
            errors: [
              {
                text: `Cannot resolve "${args.path}" from "${importer}": it is not in the window's import map (${previewExternals.join(', ')}) and was not found in the Project's node_modules. Stub it in the preview wrapper.`,
              },
            ],
          }
        : { path: packaged, namespace: SOURCE_NS };
    });

    context.onLoad({ filter: /.*/, namespace: SOURCE_NS }, async (args) => {
      const loader = loaderOf(args.path);

      if (loader === undefined) {
        return {
          errors: [
            {
              text: `"${args.path}" cannot be bundled into a preview (unsupported file type).`,
            },
          ],
        };
      }

      if (loader === 'empty') {
        // Compiled into `index.css` instead (`css.ts`).
        input.css.add(args.path);

        return { contents: '', loader };
      }

      const contents = await input.read(args.path);

      if (contents === undefined) {
        return { errors: [{ text: `"${args.path}" could not be read.` }] };
      }

      if (!/(^|\/)node_modules\//.test(args.path)) {
        input.loaded.set(args.path, contents);
      }

      return { contents, loader };
    });

    context.onLoad({ filter: /.*/, namespace: ENTRY_NS }, () => ({
      contents: input.entry ?? '',
      loader: 'js',
    }));

    context.onLoad({ filter: /.*/, namespace: SHIM_NS }, (args) => ({
      contents: STORYBOOK_SHIMS[args.path] ?? '',
      loader: 'js',
    }));

    context.onLoad({ filter: /.*/, namespace: JSX_NS }, () => ({
      contents: JSX_RUNTIME,
      loader: 'js',
    }));

    context.onLoad({ filter: /.*/, namespace: REQUIRE_NS }, (args) => ({
      contents: `export * from ${JSON.stringify(args.path)};\n`,
      loader: 'js',
    }));
  },
});

/**
 * The Project's `paths` aliases: `tsconfig.json`, else the first of its
 * relative `extends` (three levels) or `references` that declares them. An
 * unreadable or unparsable tsconfig is no aliases, not a failure.
 */
const readAliases = (
  read: (path: string) => Promise<string | undefined>,
): Promise<readonly PathAlias[]> => {
  const visit = async (
    path: string,
    depth: number,
  ): Promise<readonly PathAlias[]> => {
    if (depth > 3) return [];

    let parsed: unknown;

    try {
      const text = await read(path);
      if (text === undefined) return [];
      parsed = parseJsonc(text);
    } catch {
      return [];
    }

    if (!isRecord(parsed)) return [];

    const options = isRecord(parsed.compilerOptions)
      ? parsed.compilerOptions
      : {};
    const dir = posix.dirname(path);

    if (isRecord(options.paths)) {
      const baseUrl =
        typeof options.baseUrl === 'string' ? options.baseUrl : '.';
      const base = posix.normalize(posix.join(dir, baseUrl));

      return Object.entries(options.paths).flatMap(([key, value]) => {
        if (!Array.isArray(value)) return [];

        const star = key.indexOf('*');
        const targets = value
          .filter((item): item is string => typeof item === 'string')
          .map((item) => posix.normalize(posix.join(base, item)))
          .filter((item) => item !== '..' && !item.startsWith('../'));

        return [
          {
            prefix: star < 0 ? key : key.slice(0, star),
            suffix: star < 0 ? '' : key.slice(star + 1),
            wildcard: star >= 0,
            targets,
          },
        ];
      });
    }

    const next = [
      ...(typeof parsed.extends === 'string' && isRelative(parsed.extends)
        ? [parsed.extends]
        : []),
      ...(Array.isArray(parsed.references)
        ? parsed.references
            .map((reference) =>
              isRecord(reference) && typeof reference.path === 'string'
                ? reference.path
                : undefined,
            )
            .filter((item): item is string => item !== undefined)
        : []),
    ];

    for (const item of next) {
      const target = projectPath(path, item);
      if (target === undefined) continue;

      const file = target.endsWith('.json')
        ? target
        : `${target}/tsconfig.json`;
      const aliases = await visit(file, depth + 1);

      if (aliases.length > 0) return aliases;
    }

    return [];
  };

  return visit('tsconfig.json', 0);
};

/* The build --------------------------------------------------------------- */

const exportsOf = (metafile: Metafile): readonly string[] =>
  Object.values(metafile.outputs).find(
    (output) => output.entryPoint !== undefined,
  )?.exports ?? [];

/**
 * Compiles one component source into the preview module and its sheet. Fails
 * with `invalid_input`, naming esbuild's errors, when the source does not
 * compile, an import cannot be resolved, or the export to mount is missing.
 * A Project harness that does not compile is left out with a warning.
 */
export const compileComponent = async (
  read: SourceReader,
  input: { readonly path: string; readonly entry?: string },
): Promise<CompiledComponent> => {
  const { build } = await import('esbuild');
  const cached = sourceCache(read);
  const loaded = new Map<string, string>();
  const warnings = new Set<string>();
  const aliases = await readAliases(cached);

  const options = (pass: {
    readonly css: Set<string>;
    readonly entry?: string;
    readonly harnessPath?: string;
  }): BuildOptions & { readonly metafile: true; readonly write: false } => ({
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    metafile: true,
    outfile: 'index.js',
    jsx: 'automatic',
    jsxDev: true,
    jsxImportSource: JSX_SOURCE,
    define: { 'process.env.NODE_ENV': '"production"' },
    legalComments: 'none',
    charset: 'utf8',
    logLevel: 'silent',
    plugins: [
      sandboxPlugin({
        read: cached,
        sourcePath: input.path,
        ...pass,
        aliases,
        loaded,
      }),
    ],
  });

  const run = async <T>(step: () => Promise<T>): Promise<T> => {
    try {
      return await step();
    } catch (error) {
      if (error instanceof ContractError) throw error;

      throw new ContractError(
        'invalid_input',
        `The component preview "${input.path}" did not compile:\n${failureOf(error)}`,
        { path: input.path },
      );
    }
  };

  // Pass 1: the source alone, for the exports it has (and its errors).
  const probe = await run(() =>
    build({ ...options({ css: new Set() }), entryPoints: [input.path] }),
  );
  const exports = exportsOf(probe.metafile);
  const stories = storyOrder((await cached(input.path)) ?? '', exports);
  const storiesFile = isStoriesFile(input.path);
  const exportName = storiesFile
    ? pickStory(input.path, stories, input.entry)
    : pickExport(input.path, exports, input.entry);

  // Pass 2: the Project's harness alone. One that does not compile is left
  // out, so the preview still renders — without the Project's providers.
  let harnessPath = await findHarness(cached, input.path);
  const globalCss = new Set<string>();

  if (harnessPath !== undefined) {
    const path = harnessPath;

    try {
      await build({
        ...options({ css: globalCss }),
        entryPoints: [path],
      });
    } catch (error) {
      warnings.add(
        `The preview harness "${path}" was not applied: it did not compile, so the preview renders without its decorators and global CSS.\n${failureOf(error)}`,
      );
      harnessPath = undefined;
      globalCss.clear();
    }
  }

  // Pass 3: the module the node imports, around the chosen export.
  const css = new Set<string>();
  const result = await run(() =>
    build({
      ...options({
        css,
        entry: entryModule({
          exportName,
          storiesFile,
          stories,
          harness: harnessPath !== undefined,
        }),
        ...(harnessPath === undefined ? {} : { harnessPath }),
      }),
      entryPoints: [ENTRY_ID],
    }),
  );
  const js = result.outputFiles.find((file) => file.path.endsWith('.js'));

  if (js === undefined) {
    throw new ContractError(
      'invalid_input',
      `The component preview "${input.path}" produced no module.`,
      { path: input.path },
    );
  }

  // `mount`'s own portal container import carries no classes.
  const usesDesktopUi = Object.values(result.metafile.outputs).some((output) =>
    output.imports.some(
      (entry) =>
        entry.external === true &&
        entry.path !== PORTAL_CONTAINER_SPECIFIER &&
        (entry.path === 'desktop/ui' || entry.path.startsWith('desktop/ui/')),
    ),
  );

  const styles = await run(() =>
    compileStyles({
      read: cached,
      sources: loaded,
      usesDesktopUi,
      globalCss: [...globalCss],
      componentCss: [...css].filter((path) => !globalCss.has(path)),
    }),
  );

  return {
    js: js.text,
    css: styles.css,
    exportName,
    ...(harnessPath === undefined ? {} : { harness: harnessPath }),
    warnings: [...warnings, ...styles.warnings],
  };
};
