const { NxAppWebpackPlugin } = require('@nx/webpack/app-plugin');
const { NxReactWebpackPlugin } = require('@nx/react/webpack-plugin');
const { join } = require('node:path');

/**
 * Every window loads one shell page from `doric://app`, and main serves this
 * build's files under `/platform/shell@<version>/`. The version is the
 * platform's (`PLATFORM_VERSION`), so the shell's URLs are fixed per release.
 */
const shellPath = '/platform/shell@1.0.0/';

module.exports = {
  // rehype-harden publishes a map for src/index.ts without shipping that source.
  ignoreWarnings: [
    {
      module: /node_modules[\\/]rehype-harden[\\/]dist[\\/]index\.js/,
      message: /Failed to parse source map/,
    },
  ],
  output: {
    path: join(__dirname, '../../dist/app/doric-renderer'),
    clean: true,
    // Nx defaults to module scripts while Webpack emits classic worker chunks.
    // Keep their public-path runtime on self.location, not import.meta.url.
    scriptType: 'text/javascript',
    publicPath: shellPath,
  },
  resolve: {
    // Workspace packages (desktop-client, desktop-ui, bundle) compile from
    // source, so the legacy tree and the shell share this build's one React.
    conditionNames: ['@org/source', 'import', 'module', 'browser', 'default'],
    alias: {
      '@': join(__dirname, 'src'),
    },
  },
  devServer: {
    port: 4200,
    // The page's origin is `doric://app`, so the HMR socket cannot be derived
    // from it, and the requests main forwards carry that origin's host.
    allowedHosts: 'all',
    client: { webSocketURL: 'ws://localhost:4200/ws' },
    devMiddleware: { publicPath: shellPath },
    historyApiFallback: {
      index: `${shellPath}shell.html`,
      disableDotRule: true,
      htmlAcceptHeaders: ['text/html', 'application/xhtml+xml'],
    },
  },
  plugins: [
    new NxAppWebpackPlugin({
      tsConfig: './tsconfig.app.json',
      compiler: 'babel',
      main: './src/bootstrap.ts',
      // Main renders this template per request (import map, theme, CSP), so
      // its scripts and styles are absolute under the shell's path and the
      // page carries no `<base>`.
      index: './src/shell.html',
      baseHref: false,
      deployUrl: shellPath,
      // Vendored fonts are emitted by css-loader with content hashes; copying
      // them raw as well would ship every font twice. The license still ships.
      assets: [
        './src/favicon.ico',
        {
          input: './src/assets',
          glob: '**/*',
          ignore: ['fonts/*.woff2'],
          output: 'assets',
        },
      ],
      styles: ['./src/styles.css'],
      outputHashing: process.env.NODE_ENV === 'production' ? 'all' : 'none',
      optimization: process.env.NODE_ENV === 'production',
    }),
    new NxReactWebpackPlugin({
      // Uncomment this line if you don't want to use SVGR
      // See: https://react-svgr.com/
      // svgr: false
    }),
  ],
};
