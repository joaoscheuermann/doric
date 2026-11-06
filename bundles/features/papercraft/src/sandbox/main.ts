// The sandbox runner's entry, bundled into `dist/sandbox/runner.mjs`, which
// the host copies into the workspace and runs as
// `node runner.mjs <input.json> <output.json>` from the workspace root.
// Started as a worker (a library job's evaluation, D12), it evaluates instead.

import { readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMainThread, workerData } from 'node:worker_threads';

import { evaluateInWorker, runLibrary } from './library.js';
import type { RunnerJob } from './protocol.js';
import { type RunnerEsbuild, runBundle } from './run.js';

const loadEsbuild = async (path: string): Promise<RunnerEsbuild> => {
  // esbuild is CommonJS: its exports are the default export's members.
  const loaded = (await import(pathToFileURL(path).href)) as {
    readonly default?: RunnerEsbuild;
  } & RunnerEsbuild;

  return loaded.default ?? loaded;
};

if (!isMainThread) {
  await evaluateInWorker(workerData as { readonly evaluate: string });
} else {
  const [inputPath, outputPath] = process.argv.slice(2);

  if (inputPath === undefined || outputPath === undefined) {
    throw new Error('Usage: node runner.mjs <input.json> <output.json>');
  }

  const input = JSON.parse(await readFile(inputPath, 'utf8')) as RunnerJob;
  const output =
    input.kind === 'library'
      ? await runLibrary(input, {
          root: process.cwd(),
          jobDir: dirname(outputPath),
          self: fileURLToPath(import.meta.url),
          loadEsbuild,
        })
      : await runBundle(input, { root: process.cwd(), loadEsbuild });

  await writeFile(outputPath, JSON.stringify(output));
}
