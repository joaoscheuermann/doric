import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

import { build } from 'esbuild';

/** Bundle current flows without copying their policy into a second implementation. */
await rm('benchmarks/harness/dist/local', { recursive: true, force: true });

await mkdir('benchmarks/harness/dist/local/bundles/core', { recursive: true });

await build({
  entryPoints: ['benchmarks/harness/src/agent.mjs'],
  outfile: 'benchmarks/harness/dist/local/agent.mjs',
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

await cp(
  'bundles/core/skills',
  'benchmarks/harness/dist/local/bundles/core/skills',
  { recursive: true },
);

const manifest = JSON.parse(
  await readFile('bundles/core/manifest.json', 'utf8'),
);

await writeFile(
  'benchmarks/harness/dist/local/bundles/core/manifest.json',
  JSON.stringify(manifest),
);

await build({
  entryPoints: manifest.tools.map(
    ({ path }) => 'bundles/core/' + path.replace(/\.js$/, '.ts'),
  ),
  outdir: 'benchmarks/harness/dist/local/bundles/core/tools',
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

await writeFile(
  'benchmarks/harness/dist/local/package.json',
  '{"type":"module"}\n',
);
