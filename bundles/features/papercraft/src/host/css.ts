// The sheet of a component preview (`index.css`), compiled with Tailwind v4.
//
// Two bases, one compiler:
//
// - **The generic theme** (the default, `theme.ts`): Tailwind's theme
//   variables, preflight and utilities, and a neutral shadcn token set in
//   light and dark. It belongs to no application, Doric included.
// - **The Project's global CSS**: the stylesheets the preview harness
//   (`.storybook/preview.*` / `.papercraft/preview.*`) imports for their side
//   effect — usually the Project's Tailwind entry (`@import "tailwindcss";`
//   plus its tokens). They replace the generic theme.
//
// Either way, the sheet is linked in the preview's own document (the
// frame's), so its rules apply as written: `:root` is the frame's `<html>`,
// and `.dark` matches the class the frame runtime puts there.
//
// Every Project stylesheet is read through the sandbox reader (`files/v1`):
// Tailwind's `loadStylesheet` hook resolves relative and root-relative
// `@import`s in the Project, bare ones in the Project's `node_modules` (the
// `style` export), and `tailwindcss` itself — and any stylesheet package the
// Project does not have — on the host, so the compiler and its sheets are one
// version. A JavaScript `@plugin` or `@config` is skipped with a warning.
//
// A relative `url()` in a stylesheet (a font, an image) is written for that
// file's own place, which the compiled sheet does not keep: each one is
// rebased as the sheet is loaded, its bytes read (through `files/v1` for a
// Project file), and stored beside the sheet as `assets/<sha256>.<ext>`, so a
// revision carries what its sheet names. One that cannot be read, or is too
// large, stays as written, with a warning.
//
// CSS files the components import are concatenated after the base (plain
// CSS, or Tailwind v4 CSS that `@apply`s the base's utilities); one that is
// itself a Tailwind entry is skipped with a warning — the harness is where a
// global sheet belongs.
//
// Tailwind v3 (`@tailwind` directives, a JavaScript config) cannot be
// compiled by v4: the Project's global CSS is then skipped with a warning and
// the preview falls back to the generic theme. Any Project sheet that does
// not compile degrades the same way, one step at a time: without the
// components' CSS, then on the generic theme alone. Only a failure of the
// generic theme fails the preview.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  exportTarget,
  isRecord,
  packageOf,
  STYLE_CONDITIONS,
} from './paths.js';
import { GENERIC_ROOT } from './theme.js';

/** Reads one Project file: `undefined` when it is not there. */
export type ProjectReader = (path: string) => Promise<string | undefined>;

/** Reads one Project file's bytes: `undefined` when they cannot be read. */
export type ProjectBytesReader = (
  path: string,
) => Promise<Uint8Array | undefined>;

/** A file the sheet names, stored beside it at `path` (`assets/…`). */
export interface StyleAsset {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/** The compiled sheet and what the compile skipped. */
export interface CompiledStyles {
  readonly css: string;
  /** The files the sheet's `url()`s name, stored beside it. */
  readonly assets: readonly StyleAsset[];
  /** Which base the sheet was built on. */
  readonly base: 'generic' | 'project';
  readonly warnings: readonly string[];
}

/** The base of a Project stylesheet, as Tailwind hands it back: `sandbox:/dir`. */
const SANDBOX = 'sandbox:';

const sandboxBase = (dir: string): string =>
  `${SANDBOX}/${dir === '.' ? '' : dir}`;

const sandboxDir = (base: string): string =>
  posix.normalize(base.slice(SANDBOX.length).replace(/^\/+/, '') || '.');

/** The kinds of file a sheet may name, by extension. */
const ASSET_EXTENSIONS = new Set([
  'woff2',
  'woff',
  'ttf',
  'otf',
  'svg',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'ico',
]);

/** The most bytes one asset, and all of a sheet's, may take. */
const ASSET_LIMIT_BYTES = 4_194_304;
const ASSETS_LIMIT_BYTES = 16_777_216;

/** The placeholder a rebased `url()` carries until its bytes are stored. */
const ASSET = 'papercraft-asset:';

/** `url(…)` outside an `@import`, quoted or not. */
const URL_PATTERN = /(?<!@import\s*)url\(\s*(['"]?)([^'")]*?)\1\s*\)/g;

/** A reference no file of the Project's stands behind. */
const isExternal = (reference: string): boolean =>
  reference === '' ||
  reference.startsWith('#') ||
  reference.startsWith('//') ||
  /^[a-z][a-z0-9+.-]*:/i.test(reference);

/**
 * Rewrites every relative `url()` of a sheet loaded from `dir` to a
 * placeholder naming its file outright: `project:<path>` for a Project file
 * (a root-relative one from the Project's root), `host:<path>` for one on the
 * host disk. A Project reference that leaves the Project stays as written.
 */
const rebaseUrls = (
  content: string,
  dir: string,
  origin: 'project' | 'host',
  originals: Map<string, string>,
): string =>
  content.replace(URL_PATTERN, (whole, _quote: string, reference: string) => {
    const trimmed = reference.trim();
    if (isExternal(trimmed)) return whole;

    const cut = trimmed.search(/[?#]/);
    const file = cut === -1 ? trimmed : trimmed.slice(0, cut);
    const suffix = cut === -1 ? '' : trimmed.slice(cut);
    const path =
      origin === 'project' && file.startsWith('/')
        ? posix.normalize(file.slice(1))
        : posix.normalize(posix.join(dir, file));

    if (origin === 'project' && (path === '..' || path.startsWith('../'))) {
      return whole;
    }

    const placeholder = `${origin}:${path}${suffix}`;
    originals.set(placeholder, whole);

    return `url(${JSON.stringify(`${ASSET}${placeholder}`)})`;
  });

const PLACEHOLDER_PATTERN = new RegExp(
  `url\\(\\s*(['"])${ASSET}(project|host):([^'"]*)\\1\\s*\\)`,
  'g',
);

/**
 * Stores the files a built sheet's placeholders name as `assets/<sha256>.<ext>`
 * and points each `url()` at its copy; one that cannot be stored gets back
 * the `url()` its sheet wrote.
 */
const storeAssets = async (
  css: string,
  readBytes: ProjectBytesReader | undefined,
  originals: ReadonlyMap<string, string>,
  warnings: Set<string>,
): Promise<{ css: string; assets: StyleAsset[] }> => {
  const assets = new Map<string, StyleAsset>();
  const targets = new Map<string, string | undefined>();
  let total = 0;

  for (const [, , origin, reference] of css.matchAll(PLACEHOLDER_PATTERN)) {
    const key = `${origin}:${reference}`;
    if (reference === undefined || targets.has(key)) continue;

    const cut = reference.search(/[?#]/);
    const path = cut === -1 ? reference : reference.slice(0, cut);
    const suffix = cut === -1 ? '' : reference.slice(cut);
    const extension = posix.extname(path).slice(1).toLowerCase();

    if (!ASSET_EXTENSIONS.has(extension)) {
      warnings.add(
        `The preview's sheet names "${path}", which is not a font or an image, so it was not stored with the preview.`,
      );
      targets.set(key, undefined);
      continue;
    }

    const bytes =
      origin === 'host'
        ? await readFile(path).catch(() => undefined)
        : await readBytes?.(path);

    if (bytes === undefined) {
      warnings.add(
        `The preview's sheet names "${path}", which could not be read, so the preview goes without it.`,
      );
      targets.set(key, undefined);
      continue;
    }

    if (
      bytes.byteLength > ASSET_LIMIT_BYTES ||
      total + bytes.byteLength > ASSETS_LIMIT_BYTES
    ) {
      warnings.add(
        `The preview's sheet names "${path}", too large to store with the preview, so the preview goes without it.`,
      );
      targets.set(key, undefined);
      continue;
    }

    const sha = createHash('sha256').update(bytes).digest('hex');
    const stored = `assets/${sha}.${extension}`;

    if (!assets.has(stored)) {
      assets.set(stored, { path: stored, bytes });
      total += bytes.byteLength;
    }

    targets.set(key, `./${stored}${suffix}`);
  }

  return {
    css: css.replace(
      PLACEHOLDER_PATTERN,
      (_whole, _quote: string, origin: string, reference: string) => {
        const key = `${origin}:${reference}`;
        const target = targets.get(key);

        return target === undefined
          ? (originals.get(key) ?? 'none')
          : `url(${JSON.stringify(target)})`;
      },
    ),
    assets: [...assets.values()],
  };
};

/** Whether a stylesheet is written for Tailwind v3. */
export const isTailwindV3 = (css: string): boolean =>
  /@tailwind\s+(?:base|components|utilities|variants|screens)\b/.test(css);

/** Whether a stylesheet is a Tailwind entry (a global sheet, not a component's). */
const isTailwindEntry = (css: string): boolean =>
  isTailwindV3(css) || /@import\s+(?:url\()?["']tailwindcss["']/.test(css);

/** Where the host's own stylesheet packages (`tailwindcss`) resolve from. */
const hostBase = (): string => dirname(fileURLToPath(import.meta.url));

/** The stylesheet one package subpath names, from its manifest. */
const styleTarget = (manifest: unknown, subpath: string): string => {
  const fields = isRecord(manifest) ? manifest : {};

  if (fields.exports !== undefined) {
    const target = exportTarget(fields.exports, subpath, STYLE_CONDITIONS);
    if (target !== undefined) return target;
  }

  if (subpath === '.') {
    if (typeof fields.style === 'string') return fields.style;
    if (typeof fields.main === 'string' && fields.main.endsWith('.css')) {
      return fields.main;
    }

    return 'index.css';
  }

  return subpath.endsWith('.css') ? subpath : `${subpath}.css`;
};

/** A stylesheet package on the host disk, found walking up from `from`. */
const readHostPackage = async (
  id: string,
  from: string,
): Promise<{ path: string; content: string } | undefined> => {
  const name = packageOf(id);
  const rest = id.slice(name.length);
  const subpath = rest === '' ? '.' : `.${rest}`;
  let dir = from;

  for (;;) {
    const pkgDir = posix.join(dir, 'node_modules', name);
    const manifest = await readFile(
      posix.join(pkgDir, 'package.json'),
      'utf8',
    ).catch(() => undefined);

    if (manifest !== undefined) {
      const path = posix.join(
        pkgDir,
        styleTarget(JSON.parse(manifest), subpath),
      );
      const content = await readFile(path, 'utf8').catch(() => undefined);

      return content === undefined ? undefined : { path, content };
    }

    const parent = posix.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
};

/** The Tailwind loader hooks over the sandbox and the host. */
const loaders = (input: {
  readonly read: ProjectReader;
  readonly hostBase: string;
  readonly warnings: Set<string>;
  readonly originals: Map<string, string>;
}) => {
  const fromProject = (path: string, content: string) => ({
    path,
    base: sandboxBase(posix.dirname(path)),
    content: rebaseUrls(
      content,
      posix.dirname(path),
      'project',
      input.originals,
    ),
  });

  const fromHost = (path: string, content: string) => ({
    path,
    base: posix.dirname(path),
    content: rebaseUrls(content, posix.dirname(path), 'host', input.originals),
  });

  const readProject = async (path: string) => {
    const content = await input.read(path);

    if (content === undefined) {
      throw new Error(`The stylesheet "${path}" is not in the Project.`);
    }

    return fromProject(path, content);
  };

  const readProjectPackage = async (id: string, from: string) => {
    const name = packageOf(id);
    const rest = id.slice(name.length);
    const subpath = rest === '' ? '.' : `.${rest}`;
    let dir = from;

    for (;;) {
      const pkgDir =
        dir === '.' ? `node_modules/${name}` : `${dir}/node_modules/${name}`;
      const manifest = await input.read(`${pkgDir}/package.json`);

      if (manifest !== undefined) {
        const path = posix.join(
          pkgDir,
          styleTarget(JSON.parse(manifest), subpath),
        );
        const content = await input.read(path);

        return content === undefined ? undefined : fromProject(path, content);
      }

      if (dir === '.' || dir === '') return undefined;
      dir = posix.dirname(dir);
    }
  };

  const readHost = async (id: string, from: string) => {
    const found = await readHostPackage(id, from);

    if (found === undefined) {
      throw new Error(`Cannot resolve the stylesheet "${id}".`);
    }

    return fromHost(found.path, found.content);
  };

  return {
    base: input.hostBase,
    async loadStylesheet(id: string, base: string) {
      // A Project stylesheet named outright (the root sheet's imports).
      if (id.startsWith(SANDBOX)) return readProject(sandboxDir(id));

      if (base.startsWith(SANDBOX)) {
        const dir = sandboxDir(base);

        if (id.startsWith('./') || id.startsWith('../') || id.startsWith('/')) {
          const path = id.startsWith('/')
            ? posix.normalize(id.slice(1))
            : posix.normalize(posix.join(dir, id));

          if (path === '..' || path.startsWith('../')) {
            throw new Error(`"${id}" resolves outside the Project.`);
          }

          return readProject(path);
        }

        // The compiler's own sheets always come from the host: one version.
        if (packageOf(id) !== 'tailwindcss') {
          const found = await readProjectPackage(id, dir);
          if (found !== undefined) return found;
        }

        return readHost(id, input.hostBase);
      }

      if (id.startsWith('./') || id.startsWith('../')) {
        const path = posix.join(base, id);

        return fromHost(path, await readFile(path, 'utf8'));
      }

      return readHost(id, base);
    },
    loadModule(id: string, base: string, hint: 'plugin' | 'config') {
      input.warnings.add(
        `The preview skipped the Tailwind ${hint === 'plugin' ? '@plugin' : '@config'} "${id}": JavaScript Tailwind ${hint}s are not loaded.`,
      );

      return Promise.resolve({
        path: id,
        base,
        // biome-ignore lint/suspicious/noExplicitAny: Tailwind's plugin and config types are not exported
        module: (hint === 'plugin' ? () => undefined : {}) as any,
      });
    },
  };
};

/**
 * The `@theme inline` mapping names some tokens after themselves
 * (`--font-sans: var(--font-sans)`): a cycle, which voids the token wherever
 * it wins the cascade over the Project's own definition. Those declarations
 * are dropped.
 */
const dropSelfReferences = (css: string): string =>
  css.replace(/^[ \t]*(--[\w-]+):\s*var\(\1\);[ \t]*\n/gm, '');

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const importOf = (path: string): string =>
  `@import ${JSON.stringify(`${SANDBOX}/${path}`)};`;

/**
 * The sheet a preview's document links: the base (the Project's global CSS
 * when the harness imports it, else the generic theme), the utilities of every
 * class in the Project files the module bundles, and the CSS the components
 * import.
 */
export const compileStyles = async (input: {
  readonly read: ProjectReader;
  /** Reads the bytes of a Project file the sheet names (a font, an image). */
  readonly readBytes?: ProjectBytesReader;
  readonly sources: ReadonlyMap<string, string>;
  /** The Project stylesheets the harness imports, in import order. */
  readonly globalCss?: readonly string[];
  /** The Project stylesheets the components import, in import order. */
  readonly componentCss?: readonly string[];
}): Promise<CompiledStyles> => {
  const [{ compile }, { Scanner }] = await Promise.all([
    import('tailwindcss'),
    import('@tailwindcss/oxide'),
  ]);
  const warnings = new Set<string>();

  let globals = [...(input.globalCss ?? [])];

  for (const path of globals) {
    if (isTailwindV3((await input.read(path)) ?? '')) {
      warnings.add(
        `The preview harness imports "${path}", written for Tailwind v3 (\`@tailwind\` directives); previews compile Tailwind v4, so the Project's global CSS was skipped and the preview uses the generic theme.`,
      );
      globals = [];
      break;
    }
  }

  const components: string[] = [];

  for (const path of input.componentCss ?? []) {
    if (globals.includes(path)) continue;

    if (isTailwindEntry((await input.read(path)) ?? '')) {
      warnings.add(
        `"${path}" is a Tailwind entry, not a component stylesheet, so the preview skipped it; import it from the preview harness (.papercraft/preview.tsx or .storybook/preview.tsx) to use it as the Project's global CSS.`,
      );
    } else {
      components.push(path);
    }
  }

  const candidates = new Scanner({ sources: [] }).scanFiles(
    [...input.sources].map(([path, content]) => ({
      content,
      extension: posix.extname(path).slice(1) || 'tsx',
    })),
  );

  /** Each rebased `url()`'s placeholder, with the `url()` its sheet wrote. */
  const originals = new Map<string, string>();

  const attempt = async (
    base: 'generic' | 'project',
    extra: readonly string[],
  ): Promise<string> => {
    const root = [
      ...(base === 'project' ? globals.map(importOf) : GENERIC_ROOT),
      ...extra.map(importOf),
    ].join('\n');
    const compiler = await compile(
      root,
      loaders({ read: input.read, hostBase: hostBase(), warnings, originals }),
    );
    return dropSelfReferences(compiler.build(candidates));
  };

  const plans: { base: 'generic' | 'project'; extra: readonly string[] }[] = [
    ...(globals.length > 0
      ? [
          { base: 'project' as const, extra: components },
          ...(components.length > 0
            ? [{ base: 'project' as const, extra: [] }]
            : []),
        ]
      : []),
    ...(globals.length === 0 && components.length > 0
      ? [{ base: 'generic' as const, extra: components }]
      : []),
    { base: 'generic', extra: [] },
  ];

  for (const [index, plan] of plans.entries()) {
    const last = index === plans.length - 1;

    try {
      const stored = await storeAssets(
        await attempt(plan.base, plan.extra),
        input.readBytes,
        originals,
        warnings,
      );

      return { ...stored, base: plan.base, warnings: [...warnings] };
    } catch (error) {
      if (last) throw error;

      const next = plans[index + 1];
      const what =
        plan.extra.length > 0 && next?.base === plan.base
          ? `the components' CSS (${plan.extra.join(', ')})`
          : `the Project's global CSS (${globals.join(', ')})`;

      warnings.add(
        `The preview skipped ${what}: it did not compile (${messageOf(error)}).`,
      );
    }
  }

  // Unreachable: the last plan either returns or throws.
  throw new Error('No stylesheet plan compiled.');
};
