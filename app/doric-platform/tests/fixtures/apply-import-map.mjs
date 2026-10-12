/**
 * Loads modules the way a window does: every bare specifier listed in the
 * platform import map resolves to the emitted file, with `doric://app/platform/`
 * rewritten to the build folder on disk. Specifiers the map does not list fall
 * back to Node's resolution (the test's own `react-dom/server`), and their
 * CommonJS `require('react')` goes through the map too, so one React instance
 * serves both.
 *
 *   node apply-import-map.mjs <platform dir> <module to import>
 */
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [platformDir, entry] = process.argv.slice(2);
const { imports } = JSON.parse(
  readFileSync(join(platformDir, 'importmap.platform.json'), 'utf8'),
);
const base = pathToFileURL(resolve(platformDir)).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    const target = imports[specifier];
    if (target === undefined) return nextResolve(specifier, context);
    return {
      url: target.replace('doric://app/platform', base),
      format: 'module',
      shortCircuit: true,
    };
  },
});

await import(pathToFileURL(resolve(entry)).href);
