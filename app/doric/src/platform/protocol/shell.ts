// The technical shell document, rendered per request (decision 72): the
// renderer build's `shell.html` with the generation meta tag, the import map
// and the platform theme injected as the first children of `<head>`. The
// shell never knows routes or titles [S8-2].

import { createHash } from 'node:crypto';

import { developmentCsp, packagedCsp } from './csp';
import { type ImportMap, importMapText } from './import-map';

export interface RenderedShell {
  readonly html: string;
  readonly importMapHash: string;
}

const escapeAttribute = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;');

/** base64(sha256(text)), the CSP source of an inline script. */
export const scriptHash = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('base64');

const HEAD = /<head(\s[^>]*)?>/i;

export const renderShell = (
  template: string,
  input: {
    /** The client generation of this document; null before the first one. */
    readonly generation: number | null;
    readonly importMap: ImportMap;
    /** `/platform/desktop-ui@<v>/theme.css`. */
    readonly themeHref: string;
  },
): RenderedShell => {
  const head = HEAD.exec(template);

  if (head === null) {
    throw new Error('The shell template has no <head> element.');
  }

  // `<` cannot end the script early inside JSON once escaped.
  const text = importMapText(input.importMap).replaceAll('<', '\\u003c');
  const injected = [
    ...(input.generation === null
      ? []
      : [`<meta name="doric-generation" content="${input.generation}">`]),
    `<script type="importmap">${text}</script>`,
    `<link rel="stylesheet" href="${escapeAttribute(input.themeHref)}">`,
  ].join('');
  const at = head.index + head[0].length;

  return {
    html: `${template.slice(0, at)}${injected}${template.slice(at)}`,
    importMapHash: scriptHash(text),
  };
};

export type ShellMode = 'packaged' | 'development';

export interface ShellRenderer {
  render(): Promise<{ readonly html: string; readonly csp: string }>;
}

export const createShellRenderer = (deps: {
  readonly mode: ShellMode;
  /** packaged: read from the shell root (cached); development: fetched each time. */
  readonly template: () => Promise<string>;
  readonly generation: () => number | null;
  readonly importMap: (generation: number | null) => ImportMap;
  readonly themeHref: string;
  readonly devServerOrigin: string;
}): ShellRenderer => {
  let packagedTemplate: Promise<string> | undefined;
  const maps = new Map<number | null, ImportMap>();

  return {
    render: async () => {
      if (deps.mode === 'packaged' && packagedTemplate === undefined) {
        packagedTemplate = deps.template().catch((error: unknown) => {
          packagedTemplate = undefined;
          throw error;
        });
      }

      const template = await (packagedTemplate ?? deps.template());
      const generation = deps.generation();
      let importMap = maps.get(generation);

      if (importMap === undefined) {
        importMap = deps.importMap(generation);
        maps.set(generation, importMap);
      }

      const rendered = renderShell(template, {
        generation,
        importMap,
        themeHref: deps.themeHref,
      });

      return {
        html: rendered.html,
        csp:
          deps.mode === 'packaged'
            ? packagedCsp(rendered.importMapHash)
            : developmentCsp(rendered.importMapHash, deps.devServerOrigin),
      };
    },
  };
};
