// The Project's preview harness: a versioned file of the Project, in
// Storybook's `Preview` shape, that wraps every component preview.
//
// A preview mounts in its own React root, so none of the app's providers
// reach it. The harness is where a Project states them once — Router, query
// client, store, i18n, theme — as Storybook decorators, plus the global CSS
// (`import '../src/index.css'`) the preview's sheet is compiled from
// (`css.ts`). Projects that already use Storybook get it for free.
//
// Resolution: walking up from the previewed file's directory to the
// workspace root, the first directory that has `.storybook/preview.<ext>`,
// else `.papercraft/preview.<ext>` (`<ext>` in `.tsx`, `.ts`, `.jsx`,
// `.js`), wins — so a monorepo package's own `.storybook/` serves the
// previews of its files. Directories inside `.doric/` (the artifact area,
// where draft stories live) and `node_modules/` are skipped, so a draft
// resolves the workspace root's harness.
//
// The supported subset of Storybook's `preview.*`: a default export
// `{ decorators?, parameters?, args? }` and/or the named `decorators`,
// `parameters` and `args` exports. Type-only `@storybook/*` imports erase in
// the build. `@storybook/addon-themes` is served by a small built-in
// stand-in (its real decorators need Storybook's own hooks and channel,
// which do not run outside Storybook); any other runtime import goes through
// the Project resolution of `compile.ts`, and a harness that cannot be
// bundled is left out with a warning naming the failure — the preview still
// compiles, without it.

import { posix } from 'node:path';

/** The directories a harness lives in, in the order they are preferred. */
export const HARNESS_DIRS: readonly string[] = ['.storybook', '.papercraft'];

const HARNESS_EXTENSIONS: readonly string[] = ['.tsx', '.ts', '.jsx', '.js'];

const skipped = (dir: string): boolean =>
  dir.split('/').some((part) => part === '.doric' || part === 'node_modules');

/** The candidate harness files of one preview, nearest first. */
export const harnessCandidates = (sourcePath: string): readonly string[] => {
  const candidates: string[] = [];
  let dir = posix.dirname(sourcePath);

  for (;;) {
    if (!skipped(dir)) {
      for (const harnessDir of HARNESS_DIRS) {
        for (const extension of HARNESS_EXTENSIONS) {
          candidates.push(
            dir === '.'
              ? `${harnessDir}/preview${extension}`
              : `${dir}/${harnessDir}/preview${extension}`,
          );
        }
      }
    }

    if (dir === '.' || dir === '' || dir === '/') break;
    dir = posix.dirname(dir);
  }

  return candidates;
};

/** The Project's harness for one preview, or `undefined` when it has none. */
export const findHarness = async (
  read: (path: string) => Promise<string | undefined>,
  sourcePath: string,
): Promise<string | undefined> => {
  for (const candidate of harnessCandidates(sourcePath)) {
    if (candidate === sourcePath) continue;
    if ((await read(candidate)) !== undefined) return candidate;
  }

  return undefined;
};

/**
 * Built-in stand-ins for Storybook runtime packages a harness commonly
 * imports. Each follows the addon's public API, keyed on the preview's theme
 * (`context.globals.theme`, `'light'` or `'dark'`), and wraps the story in
 * an element instead of touching `document.documentElement`, which the
 * shadow-rooted preview does not own.
 */
export const STORYBOOK_SHIMS: Readonly<Record<string, string>> = {
  '@storybook/addon-themes': `import { createElement, Fragment } from 'react';
const pick = (themes, defaultTheme, context) => {
  const names = Object.keys(themes || {});
  const wanted = context && context.globals ? context.globals.theme : undefined;
  if (wanted !== undefined && names.includes(wanted)) return wanted;
  if (defaultTheme !== undefined && names.includes(defaultTheme)) return defaultTheme;
  return names[0];
};
export const withThemeByClassName = ({ themes, defaultTheme } = {}) => (Story, context) =>
  createElement('div', { className: (themes || {})[pick(themes, defaultTheme, context)] || undefined, style: { display: 'contents' } }, createElement(Story));
export const withThemeByDataAttribute = ({ themes, defaultTheme, attributeName = 'data-theme' } = {}) => (Story, context) =>
  createElement('div', { [attributeName]: (themes || {})[pick(themes, defaultTheme, context)], style: { display: 'contents' } }, createElement(Story));
export const withThemeFromJSXProvider = ({ themes, defaultTheme, Provider, GlobalStyles } = {}) => (Story, context) => {
  const theme = (themes || {})[pick(themes, defaultTheme, context)];
  const body = createElement(Fragment, null, GlobalStyles ? createElement(GlobalStyles) : null, createElement(Story));
  return Provider ? createElement(Provider, { theme }, body) : body;
};
export const DecoratorHelpers = {};
`,
};
