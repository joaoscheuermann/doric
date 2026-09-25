const { NxAppWebpackPlugin } = require('@nx/webpack/app-plugin');
const { NxReactWebpackPlugin } = require('@nx/react/webpack-plugin');
const { join } = require('path');

// The conversation harness is a page a person runs, not part of the app: it is a
// second entry and a directory of its own, added only outside a production build
// so the packaged renderer's entry point and output are what they always were.
const harness = process.env['NODE_ENV'] !== 'production';

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
  },
  resolve: {
    alias: {
      '@': join(__dirname, 'src'),
    },
  },
  devServer: {
    port: 4200,
    // Where the dev server reads files that are not built. `public` is what it
    // would serve by default anyway (it resolves its own default against the
    // project root); `tools` is mounted at `/tools` so the harness page is served
    // from where it lives, at `/tools/conversation-harness.html`.
    static: [
      { directory: join(__dirname, 'public'), watch: false },
      { directory: join(__dirname, 'tools'), publicPath: '/tools' },
    ],
    historyApiFallback: {
      index: '/index.html',
      disableDotRule: true,
      htmlAcceptHeaders: ['text/html', 'application/xhtml+xml'],
    },
  },
  plugins: [
    new NxAppWebpackPlugin({
      tsConfig: './tsconfig.app.json',
      compiler: 'babel',
      main: './src/main.tsx',
      index: './src/index.html',
      baseHref: './',
      additionalEntryPoints: harness
        ? [
            {
              entryName: 'conversation-harness',
              entryPath: './tools/conversation-harness.tsx',
            },
          ]
        : [],

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
      outputHashing: process.env['NODE_ENV'] === 'production' ? 'all' : 'none',
      optimization: process.env['NODE_ENV'] === 'production',
    }),
    new NxReactWebpackPlugin({
      // Uncomment this line if you don't want to use SVGR
      // See: https://react-svgr.com/
      // svgr: false
    }),
  ],
};
