// Adjusts nx-electron's webpack configuration of the main process and the
// preload: TypeScript compiles only this project's sources. Workspace
// packages are consumed from their built ESM entries (`dist/`), which
// webpack bundles as they are; transpiling them again as CommonJS would turn
// their imports into Node `require` calls inside the bundle.

const { resolve } = require('node:path');

module.exports = (config) => {
  for (const rule of config.module?.rules ?? []) {
    if (typeof rule === 'object' && String(rule.loader).includes('ts-loader')) {
      rule.include = [resolve(__dirname, 'src')];
    }
  }

  return config;
};
