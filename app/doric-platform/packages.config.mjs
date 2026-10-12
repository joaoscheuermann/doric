/**
 * The packages the desktop platform serves once per window under
 * `doric://app/platform/` and lists in the import map. Bundles build their
 * parts with exactly these specifiers external (decision "Import map").
 */

/** The platform URL prefix every import-map target starts with. */
export const platformUrl = 'doric://app/platform/';

/** React and ReactDOM ship CommonJS; each entry becomes one ESM file. */
export const react = [
  { specifier: 'react', package: 'react', file: 'index.js' },
  { specifier: 'react/jsx-runtime', package: 'react', file: 'jsx-runtime.js' },
  {
    specifier: 'react/jsx-dev-runtime',
    package: 'react',
    file: 'jsx-dev-runtime.js',
  },
  { specifier: 'react-dom', package: 'react-dom', file: 'index.js' },
  { specifier: 'react-dom/client', package: 'react-dom', file: 'client.js' },
];

/**
 * The Lexical packages the renderer depends on. The build adds every
 * `@lexical/*` package they depend on, transitively.
 */
export const lexicalRoots = [
  'lexical',
  '@lexical/clipboard',
  '@lexical/code',
  '@lexical/extension',
  '@lexical/history',
  '@lexical/html',
  '@lexical/link',
  '@lexical/list',
  '@lexical/markdown',
  '@lexical/react',
  '@lexical/rich-text',
  '@lexical/table',
];

/** ESM packages served with every subpath they export. */
export const esmPackages = ['zod'];

/** Platform-owned packages; their folders carry `PLATFORM_VERSION`. */
export const bundleContracts = {
  specifier: 'bundle/contracts',
  package: 'bundle',
  source: 'packages/bundle/src/contracts/index.ts',
  file: 'contracts.js',
};

export const desktopUi = {
  package: 'desktop',
  root: 'packages/desktop',
  theme: 'packages/desktop/src/styles/theme.css',
  fonts: 'packages/desktop/assets/fonts',
  /** `fonts.css` names the faces relative to its source folder. */
  fontsUrlPrefix: '../../assets/fonts/',
  tokens: 'packages/desktop/dist/tokens.json',
  /** Module workers, each served at `file` inside the desktop/ui folder. */
  workers: [
    {
      source: 'src/code/editor.worker.ts',
      file: 'workers/editor.worker.js',
    },
  ],
};

export const schemas = 'packages/bundle/dist/schemas';
