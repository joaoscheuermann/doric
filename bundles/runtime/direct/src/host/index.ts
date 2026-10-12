import {
  defineMethod,
  defineService,
  type HostContext,
} from 'bundle/contracts';
import { ExecutorV1, executorMethods } from 'runtime/contracts';

import { runDirect } from './executor.js';
import { checkpoint, historyFormat, rewind } from './history.js';

/**
 * The Direct `executor/v1`: one prompt run, its turn boundary and rewind.
 * Defined by ID: the run's loose output schema does not match the typed
 * overload's exact result type.
 */
export const directExecutor = defineService(ExecutorV1.id, {
  run: defineMethod({
    input: executorMethods.run.input,
    output: executorMethods.run.output,
    execute: (input, call, services) => runDirect(input, call, services),
  }),
  checkpoint: defineMethod({
    input: executorMethods.checkpoint.input,
    output: executorMethods.checkpoint.output,
    execute: (input) => checkpoint(input),
  }),
  rewind: defineMethod({
    input: executorMethods.rewind.input,
    output: executorMethods.rewind.output,
    execute: (input) => rewind(input),
  }),
  formats: defineMethod({
    input: executorMethods.formats.input,
    output: executorMethods.formats.output,
    execute: () => [historyFormat],
  }),
});

/** Provides the Direct executor. */
export const activate = ({ services }: HostContext): void => {
  services.provide(directExecutor);
};
