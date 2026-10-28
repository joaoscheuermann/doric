import {
  defineMethod,
  defineService,
  type HookHandle,
  HooksV1,
  type HostContext,
} from 'bundle/contracts';
import { ExecutorV1, executorMethods } from 'runtime/contracts';

import { type AgentSummary, DefaultHooksV1 } from '../contracts/index.js';
import { type AgentFile, builtInAgentFiles } from './agents/built-in.js';
import { agentsService, loadBuiltInAgents } from './agents/definitions.js';
import { compactThread } from './compact.js';
import { runPrompt } from './executor.js';
import {
  checkpoint,
  historyFormat,
  legacyHistoryFormat,
  rewind,
} from './history.js';
import { createRunVariables } from './prompts/variables.js';

/**
 * The default `executor/v1`: one prompt run, its turn boundary and rewind.
 * Defined by ID: the run's loose output schema does not match the typed
 * overload's exact result type. Every model request of a run first passes its
 * system prompt through `hooks.onBeforeModelRequestHook`. `now` is the clock
 * of the prompt date; the OS cache lives as long as the service.
 * `builtInAgents` are the agents every run lists before the workspace's own.
 */
export const createExecutor = (
  hooks: HookHandle<typeof DefaultHooksV1>,
  now: () => Date,
  builtInAgents: readonly AgentSummary[],
) => {
  const runVariables = createRunVariables(now);

  return defineService(ExecutorV1.id, {
    run: defineMethod({
      input: executorMethods.run.input,
      output: executorMethods.run.output,
      execute: (input, call, services) =>
        runPrompt(input, call, services, hooks, runVariables, builtInAgents),
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
};

/** What a caller of `activate` may set; `now` defaults to `() => new Date()`. */
export interface ActivateOptions {
  readonly now?: () => Date;
  /** The built-in agent files. Default: `builtInAgentFiles`. */
  readonly builtInAgents?: readonly AgentFile[];
}

/**
 * Defines `default.hooks/v1` and provides the default executor.
 * The runtime requires `executor/v1`, so its hooks arrive after activation,
 * when it does. The bundle loader passes no `options`.
 * Before anything else, loads the built-in agents with `loadBuiltInAgents`
 * and throws its Error, providing nothing, when one is invalid. Provides
 * `default.agents/v1` over them, and gives them to the executor.
 */
export const activate = (
  { services }: HostContext,
  options: ActivateOptions = {},
): void => {
  const builtIn = loadBuiltInAgents(options.builtInAgents ?? builtInAgentFiles);
  const hooks = services.use(HooksV1);

  services.provide(agentsService(builtIn));
  services.provide(
    createExecutor(
      hooks.define(DefaultHooksV1),
      options.now ?? (() => new Date()),
      builtIn,
    ),
  );
};
