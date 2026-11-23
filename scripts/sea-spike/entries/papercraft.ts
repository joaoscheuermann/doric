/**
 * SEA entry of the `papercraft` bundle (phase 0 spike, T0.1): bundles its host
 * part and, once its Hello is accepted, extracts its native packages from the
 * SEA's assets (esbuild and its platform binary, tailwindcss and its oxide
 * addon) into `DORIC_BUNDLE_CACHE`, loads them with `require`, and runs one
 * esbuild build and one Tailwind compile from there.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { getAsset } from 'node:sea';

import * as host from '../../../bundles/features/papercraft/src/host/index.js';
import { run } from '../client.js';

/** The asset that lists every other asset's key (written by sea-spike.mjs). */
const MANIFEST = 'spike-assets.json';

const extract = (cache: string): string[] => {
  const keys = JSON.parse(getAsset(MANIFEST, 'utf8')) as string[];
  for (const key of keys) {
    const path = join(cache, key);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, new Uint8Array(getAsset(key)));
    if (key.endsWith('/bin/esbuild')) chmodSync(path, 0o755);
  }
  writeFileSync(join(cache, 'package.json'), '{"private":true}\n');
  return keys;
};

await run(async () => {
  const cache = process.env.DORIC_BUNDLE_CACHE;
  if (!cache) throw new Error('DORIC_BUNDLE_CACHE is not set');
  const keys = extract(cache);
  const binary = keys.find((key) => key.endsWith('/bin/esbuild'));
  if (binary) process.env.ESBUILD_BINARY_PATH = join(cache, binary);
  const require = createRequire(join(cache, 'package.json'));

  const esbuild = require('esbuild') as typeof import('esbuild');
  const built = await esbuild.build({
    stdin: {
      contents:
        'export const App = () => <main className="flex p-4">papercraft</main>;',
      loader: 'tsx',
    },
    bundle: false,
    write: false,
    format: 'esm',
    jsx: 'automatic',
  });

  const tailwind = require('tailwindcss') as typeof import('tailwindcss');
  const { Scanner } =
    require('@tailwindcss/oxide') as typeof import('@tailwindcss/oxide');
  const tailwindRoot = dirname(require.resolve('tailwindcss/package.json'));
  const compiler = await tailwind.compile('@import "tailwindcss";', {
    base: tailwindRoot,
    loadStylesheet: (id: string, base: string) => {
      const name =
        id === 'tailwindcss' ? 'index.css' : id.replace(/^tailwindcss\//, '');
      const path = join(
        tailwindRoot,
        name.endsWith('.css') ? name : `${name}.css`,
      );
      return Promise.resolve({
        path,
        base,
        content: readFileSync(path, 'utf8'),
      });
    },
  });
  const candidates = new Scanner({}).scanFiles([
    { content: built.outputFiles[0]?.text ?? '', extension: 'js' },
  ]);
  const css = compiler.build(candidates);

  return {
    activate: typeof host.activate,
    esbuildBytes: built.outputFiles[0]?.contents.length ?? 0,
    tailwindBytes: css.length,
    tailwindHasFlex: css.includes('.flex'),
  };
});
