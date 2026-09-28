const { NxAppWebpackPlugin } = require('@nx/webpack/app-plugin');
const { NxReactWebpackPlugin } = require('@nx/react/webpack-plugin');
const { join } = require('path');

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
