import type { ThreadExecution } from '../../src/contracts/execution.js';

/** The execution a store test stores when its case is not about the execution. */
export const testExecution: ThreadExecution = {
  providerId: 'test-provider',
  model: 'test-model',
};
