// The utility process entry (`assets/generation-runner.mjs`): registers the
// generation's resolution before any module that imports `zod` or
// `bundle/contracts` loads, then starts the runner.

import * as nodeModule from 'node:module';

import { createResolveHook, decodeRunnerArguments } from './module-hooks';

// Node >= 22.15 (Electron 44 ships Node 24); the workspace's @types/node
// predates the declaration.
const { registerHooks } = nodeModule as unknown as {
  registerHooks(hooks: {
    resolve: ReturnType<typeof createResolveHook>;
  }): unknown;
};
const args = decodeRunnerArguments(process.argv);

registerHooks({
  resolve: createResolveHook(args.imports, args.moduleRoots ?? []),
});

await import(new URL('./generation-runner-main.mjs', import.meta.url).href);
