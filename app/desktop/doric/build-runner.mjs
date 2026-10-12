// Builds what the desktop main process loads outside webpack (S8-19):
//
// - `assets/generation-runner.mjs`: the desktopMain utility process entry. It
//   registers the generation's module resolution, then imports
//   `generation-runner-main.mjs`. Both share chunks with
//   `generation-contracts.mjs`, the one `bundle/contracts` instance of a
//   generation (the runner's and the parts'); `zod` stays external and
//   resolves to the platform's file.
// - `assets/platform/splash@<v>/`: the splash and recovery page.
//
// Usage: node app/desktop/doric/build-runner.mjs [--out dist/app/desktop/doric/assets]

import { copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
const outIndex = process.argv.indexOf('--out');
const out = resolve(
  root,
  outIndex === -1
    ? 'dist/app/desktop/doric/assets'
    : process.argv[outIndex + 1],
);
const production = process.env.NODE_ENV === 'production';
const { PLATFORM_VERSION } = await import('bundle/runtime');
const contractsEntry = fileURLToPath(import.meta.resolve('bundle/contracts'));

await rm(join(out, 'generation-chunks'), { recursive: true, force: true });
await build({
  absWorkingDir: root,
  entryPoints: {
    'generation-runner': join(
      here,
      'src/platform/generation/runner-bootstrap.ts',
    ),
    'generation-runner-main': join(
      here,
      'src/platform/generation/runner-entry.ts',
    ),
    'generation-contracts': contractsEntry,
  },
  outdir: out,
  outExtension: { '.js': '.mjs' },
  chunkNames: 'generation-chunks/[name]-[hash]',
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  external: ['zod', 'zod/*', 'electron'],
  // ajv is CommonJS: its `require` calls need a real `require` in ESM.
  banner: {
    js: "import { createRequire as __doricRequire } from 'node:module'; const require = __doricRequire(import.meta.url);",
  },
  sourcemap: production ? false : 'inline',
  minify: production,
  logLevel: 'warning',
});

const splash = join(out, 'platform', `splash@${PLATFORM_VERSION}`);
const page = join(here, 'src', 'splash-page');

await rm(splash, { recursive: true, force: true });
await mkdir(splash, { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: [join(page, 'splash.ts')],
  outfile: join(splash, 'splash.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  sourcemap: production ? false : 'inline',
  minify: production,
  logLevel: 'warning',
});

for (const file of ['index.html', 'splash.css', 'blank.html']) {
  await copyFile(join(page, file), join(splash, file));
}
