import type { Skill } from 'bundle';
import { createTestServices } from 'bundle/testing';
import pino from 'pino';
import type { BoundTool } from 'tool';

import {
  createDirectExecutor,
  type DirectExecutorOptions,
} from '../../src/lib/agents/direct/executor.js';
import { createHostAdapter } from '../../src/lib/bundles/adapter.js';
import { type Bundles, startBundles } from '../../src/lib/bundles/boot.js';
import type { ThreadExecution } from '../../src/lib/workspace/runtime.js';

/** The built bundles the host stages, and the composition it ships. */
export const bundlesPath = 'agents/doric/dist/bundles';
export const compositionPath = 'agents/doric/composition.json';

export interface DefaultBundles extends Bundles {
  /** The Direct executor over these bundles and their host adapter. */
  readonly execute: ThreadExecution;
  readonly adapter: ReturnType<typeof createHostAdapter>;
}

/**
 * Boots the default composition over the built bundles exactly as the host
 * does, with its embedded adapter, and returns the Direct executor bound to
 * them. Build doric first to populate `dist/bundles`.
 */
export const defaultBundles = async (): Promise<DefaultBundles> => {
  const adapter = createHostAdapter();
  const bundles = await startBundles({
    bundlesPath,
    compositionPath,
    adapter,
    logger: pino({ enabled: false }),
  });

  return {
    ...bundles,
    adapter,
    execute: createDirectExecutor({
      acquire: bundles.acquire,
      attach: adapter.attach,
    }),
  };
};

/**
 * A lease over a test bundle's services that binds the given tools and skills:
 * prompt calls come from that bundle and no generation process is involved.
 */
export const testLease =
  (
    tools: readonly BoundTool[] = [],
    skills: readonly Skill[] = [],
  ): DirectExecutorOptions['acquire'] =>
  () => {
    const bundle = createTestServices({ bundle: { id: 'direct-test' } });

    return Promise.resolve({
      generation: 1,
      call: (scope, signal) => bundle.call(scope, signal),
      tools: () => tools,
      skills: () => Promise.resolve(skills),
      release: () => undefined,
    });
  };

/**
 * The Direct executor for scenarios whose catalog binds no tools: prompt calls
 * come from a test bundle's services and nothing needs the prompt's Host.
 */
export const directExecutor = (): ThreadExecution =>
  createDirectExecutor({
    acquire: testLease(),
    attach: () => () => undefined,
  });
