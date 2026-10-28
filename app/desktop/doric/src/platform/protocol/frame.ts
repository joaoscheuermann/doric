// The preview frame document (docs/architecture/bundles/papercraft/
// isolamento.md): what `doric://app/frame/index.html` and
// `doric://app/frame/boot.js` serve. A preview loads this document in an
// `<iframe sandbox="allow-scripts">`, so it runs with an opaque origin: its
// own import map carries only a preview's externals as absolute
// `doric://app/platform/…` URLs, and its boot script imports the one bundle
// frame entry its `?entry=` names.

import { frameCsp } from './csp';
import type { ImportMap } from './import-map';
import { importMapText } from './import-map';
import { DORIC_ORIGIN, DORIC_ORIGIN_HOST, DORIC_SCHEME } from './scheme';
import { scriptHash } from './shell';

/** The specifiers a preview may import besides its own revision's files. */
const FRAME_SPECIFIERS: readonly string[] = [
  'react',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'react-dom',
  'react-dom/client',
];
const BASE_UI = '@base-ui/react';

const isFrameSpecifier = (specifier: string): boolean =>
  FRAME_SPECIFIERS.includes(specifier) ||
  specifier === BASE_UI ||
  specifier.startsWith(`${BASE_UI}/`);

const platformPrefix = `${DORIC_ORIGIN}/platform/`;

/**
 * The frame's import map: React, ReactDOM and every Base UI specifier of the
 * platform map, nothing else (no `desktop/ui`, no contracts, no zod).
 */
export const frameImportMap = (platform: ImportMap): ImportMap => {
  const imports: Record<string, string> = {};

  for (const [specifier, target] of Object.entries(platform.imports)) {
    if (isFrameSpecifier(specifier) && target.startsWith(platformPrefix)) {
      imports[specifier] = target;
    }
  }

  return { imports };
};

/** The frame document's body and its policy, sent as a response header. */
export interface FrameDocument {
  readonly html: string;
  readonly csp: string;
}

/**
 * Whether a URL is the frame document, whatever its query: the only place a
 * preview frame may be.
 */
export const isFrameDocumentUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url);

    return (
      parsed.protocol === `${DORIC_SCHEME}:` &&
      parsed.host === DORIC_ORIGIN_HOST &&
      parsed.pathname === '/frame/index.html'
    );
  } catch {
    return false;
  }
};

export const FRAME_BOOT_URL = `${DORIC_ORIGIN}/frame/boot.js`;

export const renderFrameDocument = (map: ImportMap): FrameDocument => {
  // `<` cannot end the script early inside JSON once escaped.
  const text = importMapText(map).replaceAll('<', '\\u003c');

  return {
    html: `<!doctype html><html><head><meta charset="utf-8"><script type="importmap">${text}</script><script type="module" src="${FRAME_BOOT_URL}"></script></head><body></body></html>`,
    csp: frameCsp(scriptHash(text)),
  };
};

/**
 * What a frame may run: `doric://app/bundles/<id>@<version>/client/frames/
 * <name>.js`, with a bundle ID and a restricted semver as the bundle
 * manifest states them, and a name without dots.
 */
export const FRAME_ENTRY_PATTERN =
  /^doric:\/\/app\/bundles\/[a-z][a-z0-9-]*@(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?\/client\/frames\/[A-Za-z0-9_-]+\.js$/;

/**
 * `boot.js`: imports the frame entry `?entry=` names when it is a bundle
 * frame module, and does nothing else otherwise. The frame's CSP already
 * limits scripts to `doric://app`; the pattern keeps a frame from running a
 * client part, a platform file or a revision as its entry.
 */
export const FRAME_BOOT_SCRIPT = `const entry = new URLSearchParams(location.search).get('entry');
if (entry !== null && ${FRAME_ENTRY_PATTERN.toString()}.test(entry)) {
  import(entry);
}
`;
