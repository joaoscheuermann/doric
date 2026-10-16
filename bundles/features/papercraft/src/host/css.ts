// The sheet of a component preview (`index.css`), compiled with Tailwind v4.
//
// Two bases, one compiler:
//
// - **Doric's theme** (the default): the app's `desktop/ui/tailwind.css`
//   mapping (`bg-primary` → `var(--primary)`), the preflight and the
//   utilities. The surface copies the app's theme variables onto the shadow
//   host, so the preview renders in the reader's theme.
// - **The Project's global CSS**: the stylesheets the preview harness
//   (`.storybook/preview.*` / `.papercraft/preview.*`) imports for their side
//   effect — usually the Project's Tailwind entry (`@import "tailwindcss";`
//   plus its tokens). They replace Doric's theme. Their `:root` rules also
//   match `:host` and the module's theme wrapper, so the Project's tokens
//   reach the shadow tree and win over the app variables the surface copies
//   onto the host.
//
// Every Project stylesheet is read through the sandbox reader (`files/v1`):
// Tailwind's `loadStylesheet` hook resolves relative and root-relative
// `@import`s in the Project, bare ones in the Project's `node_modules` (the
// `style` export), and `tailwindcss` itself — and any stylesheet package the
// Project does not have — on the host, so the compiler and its sheets are one
// version. A JavaScript `@plugin` or `@config` is skipped with a warning.
//
// CSS files the components import are concatenated after the base (plain
// CSS, or Tailwind v4 CSS that `@apply`s the base's utilities); one that is
// itself a Tailwind entry is skipped with a warning — the harness is where a
// global sheet belongs.
//
// Tailwind v3 (`@tailwind` directives, a JavaScript config) cannot be
// compiled by v4: the Project's global CSS is then skipped with a warning and
// the preview falls back to Doric's theme. Any Project sheet that does not
// compile degrades the same way, one step at a time: without the components'
// CSS, then on Doric's theme alone. Only a failure of Doric's own theme fails
// the preview.

import { readFile } from 'node:fs/promises';
import { dirname, posix } from 'node:path';

import {
  exportTarget,
  isRecord,
  packageOf,
  STYLE_CONDITIONS,
} from './paths.js';

/** Reads one Project file: `undefined` when it is not there. */
export type ProjectReader = (path: string) => Promise<string | undefined>;

/** The compiled sheet and what the compile skipped. */
export interface CompiledStyles {
  readonly css: string;
  /** Which base the sheet was built on. */
  readonly base: 'doric' | 'project';
  readonly warnings: readonly string[];
}

/** The base of a Project stylesheet, as Tailwind hands it back: `sandbox:/dir`. */
const SANDBOX = 'sandbox:';

/** The selector the module's theme wrapper and portal container carry. */
export const THEME_SCOPE = ':where([data-papercraft-theme])';

const sandboxBase = (dir: string): string =>
  `${SANDBOX}/${dir === '.' ? '' : dir}`;

const sandboxDir = (base: string): string =>
  posix.normalize(base.slice(SANDBOX.length).replace(/^\/+/, '') || '.');

/** Whether a stylesheet is written for Tailwind v3. */
export const isTailwindV3 = (css: string): boolean =>
  /@tailwind\s+(?:base|components|utilities|variants|screens)\b/.test(css);

/** Whether a stylesheet is a Tailwind entry (a global sheet, not a component's). */
const isTailwindEntry = (css: string): boolean =>
  isTailwindV3(css) || /@import\s+(?:url\()?["']tailwindcss["']/.test(css);

/** Where `desktop/ui/tailwind.css` (the app's theme mapping) sits. */
export const desktopStyles = async (): Promise<string> => {
  const { createRequire } = await import('node:module');

  return dirname(
    createRequire(import.meta.url).resolve('desktop/ui/tailwind.css'),
  );
};

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
}) => {
  const readProject = async (path: string) => {
    const content = await input.read(path);

    if (content === undefined) {
      throw new Error(`The stylesheet "${path}" is not in the Project.`);
    }

    return { path, base: sandboxBase(posix.dirname(path)), content };
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

        return content === undefined
          ? undefined
          : { path, base: sandboxBase(posix.dirname(path)), content };
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

    return { ...found, base: posix.dirname(found.path) };
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

        return {
          path,
          base: posix.dirname(path),
          content: await readFile(path, 'utf8'),
        };
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
 * Adds `:host` and the module's theme wrapper to every selector list that
 * names `:root` or `:host` alone, so a Project's tokens apply inside the
 * shadow root and win over the app variables the surface puts on the host.
 * Compound forms (`:root.dark`, `:root[data-theme]`) are left as written.
 */
export const scopeRootSelectors = (css: string): string =>
  css.replace(
    /(^|[{};])(\s*)([^{};@\s][^{};]*?)(\s*\{)/g,
    (match, lead: string, space: string, selector: string, open: string) => {
      const items = selector.split(',').map((item) => item.trim());

      if (!items.some((item) => item === ':root' || item === ':host')) {
        return match;
      }

      const next = [...items];

      for (const wanted of [':root', ':host', THEME_SCOPE]) {
        if (!next.includes(wanted)) next.push(wanted);
      }

      return `${lead}${space}${next.join(', ')}${open}`;
    },
  );

/**
 * The `@theme inline` mapping names some tokens after themselves
 * (`--font-sans: var(--font-sans)`): harmless on the page, where the tokens
 * sheet wins, but a cycle under `:host` that would void the token the surface
 * copies onto the host. Those declarations are dropped.
 */
const dropSelfReferences = (css: string): string =>
  css.replace(/^[ \t]*(--[\w-]+):\s*var\(\1\);[ \t]*\n/gm, '');

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The candidates the shared components use, scanned once per process. */
let desktopCandidates: Promise<readonly string[]> | undefined;

const scanDesktop = (stylesDir: string): Promise<readonly string[]> => {
  desktopCandidates ??= (async () => {
    const { Scanner } = await import('@tailwindcss/oxide');

    return new Scanner({
      sources: [
        { base: posix.join(stylesDir, '..'), pattern: '**/*', negated: false },
      ],
    }).scan();
  })();

  return desktopCandidates;
};

const importOf = (path: string): string =>
  `@import ${JSON.stringify(`${SANDBOX}/${path}`)};`;

/** Doric's theme: the app's mapping, the preflight and the utilities. */
const DORIC_ROOT = [
  '@layer theme, base, components, utilities;',
  "@import './tailwind.css';",
  "@import 'tailwindcss/preflight.css' layer(base);",
  "@import 'tailwindcss/utilities.css' layer(utilities);",
];

/**
 * The sheet a preview's shadow root needs: the base (the Project's global CSS
 * when the harness imports it, else Doric's theme), the utilities of every
 * class in the Project files the module bundles — plus the shared components'
 * own classes when the module imports `desktop/ui` — and the CSS the
 * components import.
 */
export const compileStyles = async (input: {
  readonly read: ProjectReader;
  readonly sources: ReadonlyMap<string, string>;
  readonly usesDesktopUi: boolean;
  /** The Project stylesheets the harness imports, in import order. */
  readonly globalCss?: readonly string[];
  /** The Project stylesheets the components import, in import order. */
  readonly componentCss?: readonly string[];
}): Promise<CompiledStyles> => {
  const [{ compile }, { Scanner }] = await Promise.all([
    import('tailwindcss'),
    import('@tailwindcss/oxide'),
  ]);
  const hostBase = await desktopStyles();
  const warnings = new Set<string>();

  let globals = [...(input.globalCss ?? [])];

  for (const path of globals) {
    if (isTailwindV3((await input.read(path)) ?? '')) {
      warnings.add(
        `The preview harness imports "${path}", written for Tailwind v3 (\`@tailwind\` directives); previews compile Tailwind v4, so the Project's global CSS was skipped and the preview uses Doric's theme.`,
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
  const used = input.usesDesktopUi
    ? [...candidates, ...(await scanDesktop(hostBase))]
    : candidates;

  const attempt = async (
    base: 'doric' | 'project',
    extra: readonly string[],
  ): Promise<string> => {
    const root = [
      ...(base === 'project' ? globals.map(importOf) : DORIC_ROOT),
      ...extra.map(importOf),
    ].join('\n');
    const compiler = await compile(
      root,
      loaders({ read: input.read, hostBase, warnings }),
    );
    const sheet = dropSelfReferences(compiler.build(used));

    return base === 'project' ? scopeRootSelectors(sheet) : sheet;
  };

  const plans: { base: 'doric' | 'project'; extra: readonly string[] }[] = [
    ...(globals.length > 0
      ? [
          { base: 'project' as const, extra: components },
          ...(components.length > 0
            ? [{ base: 'project' as const, extra: [] }]
            : []),
        ]
      : []),
    ...(globals.length === 0 && components.length > 0
      ? [{ base: 'doric' as const, extra: components }]
      : []),
    { base: 'doric', extra: [] },
  ];

  for (const [index, plan] of plans.entries()) {
    const last = index === plans.length - 1;

    try {
      const css = await attempt(plan.base, plan.extra);

      return { css, base: plan.base, warnings: [...warnings] };
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
