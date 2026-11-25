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

/**
 * ESM packages served with every subpath they export, but one whose code
 * imports a package the workspace does not install (the build names it).
 * Base UI is shared like React: its contexts and stores must be one instance
 * per window, so `desktop/ui` and every bundle reach the same copy.
 * `@bufbuild/protobuf` is shared the same way: every generated module, the
 * platform's and each bundle's, imports it, and its registries and
 * descriptors must be one instance per window (A53). `@connectrpc/connect`
 * too: a client part reads a failure with `ConnectError` and
 * `fromConnectError`, which need one module instance per window (S64).
 */
export const esmPackages = [
  'zod',
  '@base-ui/react',
  '@bufbuild/protobuf',
  '@connectrpc/connect',
];

/** Platform-owned packages; their folders carry `PLATFORM_ASSETS_VERSION`. */
export const bundleContracts = {
  specifier: 'bundle/contracts',
  package: 'bundle',
  source: 'packages/bundle/src/contracts/index.ts',
  file: 'contracts.js',
  /**
   * `bundle`'s generated code (A53): each `<path>_pb.ts` under `source` is an
   * entry of the contracts group, served as `<dir>/<path>_pb.js` in the
   * `bundle@<PLATFORM_ASSETS_VERSION>` folder under the specifier
   * `<specifier><path>_pb.js`, as `buf/validate`, `google/rpc` and the
   * platform contracts' generated files import it.
   */
  generated: {
    specifier: 'bundle/contracts/gen/',
    source: 'packages/bundle/src/contracts/gen',
    dir: 'contracts/gen',
  },
  /**
   * The client SDK (S64), an entry of the same group, so that it shares the
   * contracts' modules (`ContractError`, `fromConnectError`) with
   * `bundle/contracts` in one window.
   */
  client: {
    specifier: 'bundle/client',
    source: 'packages/bundle/src/sdk/client/index.ts',
    file: 'client.js',
  },
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
