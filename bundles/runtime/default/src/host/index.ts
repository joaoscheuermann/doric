import {
  defineMethod,
  defineService,
  type HookHandle,
  HooksV1,
  type HostContext,
} from 'bundle/contracts';
import {
  ExecutorV1,
  executorMethods,
  RuntimeHooksV1,
  type RuntimeThreads,
  RuntimeThreadsV1,
} from 'runtime/contracts';

import { DefaultHooksV1 } from '../contracts/index.js';
import { compactThread } from './compact.js';
import { runPrompt } from './executor.js';
import {
  checkpoint,
  historyFormat,
  legacyHistoryFormat,
  rewind,
} from './history.js';
import { createWorkflow, type Workflow } from './repository.js';

/**
 * The default `executor/v1`: one prompt run, its turn boundary and rewind.
 * Defined by ID: the run's loose output schema does not match the typed
 * overload's exact result type. Every model request of a run first passes its
 * system prompt through `hooks.onBeforeModelRequestHook`.
 */
export const createExecutor = (
  hooks: HookHandle<typeof DefaultHooksV1>,
  workflow: Workflow,
) =>
  defineService(ExecutorV1.id, {
    run: defineMethod({
      input: executorMethods.run.input,
      output: executorMethods.run.output,
      execute: (input, call, services) =>
        runPrompt(input, call, services, hooks, workflow),
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
      execute: () => [historyFormat, legacyHistoryFormat],
    }),
    compact: defineMethod({
      input: executorMethods.compact.input,
      output: executorMethods.compact.output,
      execute: (input, call, services) => compactThread(input, call, services),
    }),
  });

/**
 * Defines `default.hooks/v1`, provides the default executor, and gives a
 * Thread the coding workflow once, as a standing instruction: when a task
 * starts at a repository root or a running prompt moves into one, while its
 * history does not hold it. The runtime requires `executor/v1`, so its hooks
 * and Thread controls arrive after activation, when it does.
 */
export const activate = ({ services }: HostContext): void => {
  let threads: RuntimeThreads | undefined;
  const hooks = services.use(HooksV1);

  services.whenAvailable(RuntimeThreadsV1, (api) => {
    threads = api;
    return () => {
      threads = undefined;
    };
  });
  const workflow = createWorkflow(() => threads);
  hooks.whenAvailable(RuntimeHooksV1, (runtime) => {
    runtime.onThreadCwdChangedHook(workflow.onCwdChanged);
  });

  services.provide(createExecutor(hooks.define(DefaultHooksV1), workflow));
};
