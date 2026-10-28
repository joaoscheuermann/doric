// The import-map specifiers a window resolves itself, as esbuild `external`
// patterns: a client part leaves them external so one instance of React,
// Base UI, the shared UI and the contracts exists per window (decision
// "Import map").
// Kept apart from `parts.ts`, and published as `bundle/externals`, so a
// consumer (a host part that compiles a preview module for the same windows)
// reads the list without loading esbuild or the loader.

/** Import-map specifiers a client part leaves to the window. */
export const clientExternals: readonly string[] = [
  'react',
  'react/*',
  'react-dom',
  'react-dom/*',
  '@base-ui/react',
  '@base-ui/react/*',
  'lexical',
  '@lexical/*',
  'desktop/ui',
  'desktop/ui/*',
  'zod',
  'zod/*',
  'bundle/contracts',
  '*/contracts',
];

/**
 * Import-map specifiers a bundle frame (`src/client/frames/*.ts`) leaves to
 * its document: the frame's import map has only what a preview needs, so
 * everything else a frame imports is bundled into it.
 */
export const frameExternals: readonly string[] = [
  'react',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'react-dom',
  'react-dom/client',
  '@base-ui/react',
  '@base-ui/react/*',
];

/** Whether a specifier is one of esbuild-style `external` patterns. */
export const matchesExternal = (
  external: readonly string[],
  specifier: string,
): boolean =>
  external.some((pattern) => {
    const star = pattern.indexOf('*');

    if (star < 0) {
      return pattern === specifier;
    }

    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);

    return (
      specifier.length >= prefix.length + suffix.length &&
      specifier.startsWith(prefix) &&
      specifier.endsWith(suffix)
    );
  });
