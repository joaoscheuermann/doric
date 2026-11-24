// `runtime/contracts` is window-safe (phase 3, slice S62b, A72, D4/Q1, test
// 9): `src/contracts/index.ts`, executor helpers included, bundles with
// esbuild for the browser (`@org/source`, as the windows resolve it) with no
// error and no Node module. `tsconfig.client.json` cannot prove it, because
// `@types/node` reaches that program through `pino-std-serializers` and
// `undici-types`. The bundle fails the moment `executor-serving.ts` imports a
// host module (`src/host/**`, `node:async_hooks`) or `storage/rpc` (the
// storage adapters, `node:crypto`, `node:fs/promises`, `node:path`).

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { build, type Metafile } from 'esbuild';

const project = 'bundles/runtime/runtime';
const entry = `${project}/src/contracts/index.ts`;
const executorServing = `${project}/src/contracts/executor-serving.ts`;
const routedErrors = `${project}/src/contracts/routed-errors.ts`;

/** `entry` bundled for a window; the build's errors fail the test with their text. */
const bundleForWindow = async (): Promise<Metafile> => {
  try {
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      conditions: ['@org/source'],
      outfile: 'contracts-window.js',
      write: false,
      metafile: true,
      logLevel: 'silent',
    });
    assert.deepEqual(result.errors, []);
    return result.metafile;
  } catch (error) {
    const errors = (error as { errors?: { text: string }[] }).errors ?? [];
    assert.fail(
      `runtime/contracts does not bundle for a window: ${errors
        .map(({ text }) => text)
        .join('; ')}`,
    );
  }
};

/** Whether `path` is a module a window must never load. */
const isHostOnly = (path: string): boolean =>
  path.startsWith('node:') ||
  path.startsWith(`${project}/src/host/`) ||
  path === 'packages/storage/src/rpc/index.ts';

describe('S62b: runtime/contracts is window-safe', () => {
  test('src/contracts/index.ts bundles for the browser with the executor helpers and no Node module', async () => {
    const metafile = await bundleForWindow();
    const inputs = Object.keys(metafile.inputs);

    assert.ok(
      inputs.includes(executorServing),
      `${executorServing} is not part of runtime/contracts`,
    );
    assert.ok(
      inputs.includes(routedErrors),
      `${routedErrors} is not part of runtime/contracts`,
    );
    assert.ok(
      inputs.includes('packages/storage/src/rpc/chunks.ts'),
      'the chunk codec does not come from storage/rpc/chunks',
    );
    assert.deepEqual(inputs.filter(isHostOnly), []);

    const [output] = Object.values(metafile.outputs);
    assert.ok(output !== undefined);
    for (const name of [
      'serveExecutor',
      'remotePromptSession',
      'historyPatchItems',
    ]) {
      assert.ok(
        output.exports.includes(name),
        `runtime/contracts does not export ${name}`,
      );
    }
  });

  test('executor-serving.ts imports no host module and not storage/rpc', async () => {
    const metafile = await bundleForWindow();
    const serving = metafile.inputs[executorServing];

    assert.ok(serving !== undefined, `${executorServing} was not bundled`);
    assert.deepEqual(
      serving.imports.map(({ path }) => path).filter(isHostOnly),
      [],
    );
  });
});
