const { NxAppWebpackPlugin } = require('@nx/webpack/app-plugin');
const { NxReactWebpackPlugin } = require('@nx/react/webpack-plugin');
const { join } = require('node:path');
const { showsInOverlay } = require('./overlay-errors');

/**
 * Every window loads one shell page from `doric://app`, and main serves this
 * build's files under `/platform/shell@<version>/`. The version is the
 * platform's (`PLATFORM_VERSION`), so the shell's URLs are fixed per release.
 */
const shellPath = '/platform/shell@1.2.0/';

module.exports = {
  // rehype-harden publishes a map for src/index.ts without shipping that source.
  ignoreWarnings: [
    {
      module: /node_modules[\\/]rehype-harden[\\/]dist[\\/]index\.js/,
      message: /Failed to parse source map/,
    },
  ],
  output: {
    path: join(__dirname, '../../../dist/app/desktop/doric-renderer'),
    clean: true,
    // Nx defaults to module scripts while Webpack emits classic worker chunks.
    // Keep their public-path runtime on self.location, not import.meta.url.
    scriptType: 'text/javascript',
    publicPath: shellPath,
  },
  resolve: {
    // Workspace packages (desktop/client, bundle) compile from source into
    // the shell's one script.
    conditionNames: ['@org/source', 'import', 'module', 'browser', 'default'],
  },
  devServer: {
    port: 4200,
    // The page's origin is `doric://app`, so the HMR socket cannot be derived
    // from it, and the requests main forwards carry that origin's host.
    allowedHosts: 'all',
    client: {
      webSocketURL: 'ws://localhost:4200/ws',
      // ResizeObserver notices and artifact previews' errors stay out of it.
      overlay: { runtimeErrors: showsInOverlay },
    },
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
      // The faces and their licenses ship with desktop/ui's theme (stage 8);
      // the shell's only asset is its icon.
      assets: ['./src/favicon.ico'],
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
