// The sandbox runner's entry, bundled into `dist/sandbox/runner.mjs`, which
// the host copies into the workspace and runs as
// `node runner.mjs <input.json> <output.json>` from the workspace root.

import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import type { RunnerInput } from './protocol.js';
import { type RunnerEsbuild, runBundle } from './run.js';

const [inputPath, outputPath] = process.argv.slice(2);

if (inputPath === undefined || outputPath === undefined) {
  throw new Error('Usage: node runner.mjs <input.json> <output.json>');
}

const input = JSON.parse(await readFile(inputPath, 'utf8')) as RunnerInput;
const output = await runBundle(input, {
  root: process.cwd(),
  loadEsbuild: async (path) => {
    // esbuild is CommonJS: its exports are the default export's members.
    const loaded = (await import(pathToFileURL(path).href)) as {
      readonly default?: RunnerEsbuild;
    } & RunnerEsbuild;

    return loaded.default ?? loaded;
  },
});

await writeFile(outputPath, JSON.stringify(output));
