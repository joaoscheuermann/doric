// The runner's work: one bundle, run where the Project's files are. It reads
// them from the workspace's own disk, so a bundle costs no sandbox round
// trip per file and carries no read budget; what only the host has is left
// to it (`bundle.ts`).

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ContractError } from 'bundle/contracts';

import { type Build, bundleComponent, sourceCache } from '../host/bundle.js';
import type { RunnerInput, RunnerOutput } from './protocol.js';

/** The part of the esbuild module the runner uses. */
export interface RunnerEsbuild {
  readonly version: string;
  readonly build: Build;
}

const missing = new Set(['ENOENT', 'ENOTDIR', 'EISDIR']);

/** Reads one Project file under `root`: `undefined` when there is none. */
const projectReader =
  (root: string) =>
  async (path: string): Promise<string | undefined> => {
    try {
      return await readFile(join(root, path), 'utf8');
    } catch (error) {
      if (missing.has((error as { code?: string }).code ?? '')) {
        return undefined;
      }

      throw error;
    }
  };

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Bundles `input.path` from the workspace at `root`. */
export const runBundle = async (
  input: RunnerInput,
  options: {
    readonly root: string;
    readonly loadEsbuild: (path: string) => Promise<RunnerEsbuild>;
  },
): Promise<RunnerOutput> => {
  let esbuild: RunnerEsbuild;

  try {
    esbuild = await options.loadEsbuild(input.esbuild);
  } catch (error) {
    return {
      status: 'unavailable',
      reason: `esbuild could not be loaded from "${input.esbuild}": ${messageOf(error)}`,
    };
  }

  if (esbuild.version !== input.version) {
    return {
      status: 'unavailable',
      reason: `the sandbox has esbuild ${esbuild.version}, the host ${input.version}`,
    };
  }

  const read = sourceCache(projectReader(options.root), false);
  const unserved = new Set(input.windowUnserved);

  try {
    const bundled = await bundleComponent({
      read,
      build: esbuild.build,
      path: input.path,
      ...(input.entry === undefined ? {} : { entry: input.entry }),
      windowServes: (specifier) => Promise.resolve(!unserved.has(specifier)),
    });
    const styles: Record<string, string> = {};

    for (const path of [...bundled.globalCss, ...bundled.componentCss]) {
      const content = await read(path);
      if (content !== undefined) styles[path] = content;
    }

    return {
      status: 'built',
      js: bundled.js,
      exportName: bundled.exportName,
      ...(bundled.harness === undefined ? {} : { harness: bundled.harness }),
      sources: Object.fromEntries(bundled.sources),
      globalCss: [...bundled.globalCss],
      componentCss: [...bundled.componentCss],
      styles,
      windowSpecifiers: [...bundled.windowSpecifiers],
      hostSpecifiers: [...bundled.hostSpecifiers],
      warnings: [...bundled.warnings],
    };
  } catch (error) {
    if (error instanceof ContractError) {
      return {
        status: 'failed',
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      };
    }

    throw error;
  }
};
