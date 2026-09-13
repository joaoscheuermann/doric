import { readdir } from 'node:fs/promises';

import { build } from 'esbuild';

import { command } from './process.mjs';

const files = (await readdir('benchmarks/harness/tests')).filter((name) =>
  name.endsWith('.test.js'),
);

await build({
  entryPoints: files.map((name) => 'benchmarks/harness/tests/' + name),
  outdir: 'benchmarks/harness/dist-tests',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  conditions: ['@org/source'],
  legalComments: 'none',
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});

await command(process.execPath, [
  '--test',
  ...files.map((name) => 'benchmarks/harness/dist-tests/' + name),
]);
