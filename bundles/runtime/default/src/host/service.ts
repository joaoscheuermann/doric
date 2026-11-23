// `default`'s host part (phase 3, slice S51d): `executor/v1` and
// `default.agents/v1` served through the router over `routedPorts`.

import type { ServiceImpl } from '@connectrpc/connect';
import { ContractError, callOf } from 'bundle/contracts';
import { HooksService } from 'bundle/contracts/gen/doric/hooks/v1/hooks_pb.js';
import type { HostContext } from 'bundle/host';
import { ProviderErrorObject } from 'llms';
import { SessionService } from 'runtime/contracts/gen/doric/executor/session/v1/session_pb.js';
import type { ExecutorService } from 'runtime/contracts/gen/doric/executor/v1/executor_pb.js';
import { serveExecutor } from 'runtime/executor';
import { ToolErrorObject } from 'tool';

import type { AgentsService } from '../contracts/gen/doric/default/agents/v1/agents_pb.js';
import type { AgentDefinition, AgentSummary } from '../contracts/index.js';
import { type AgentFile, builtInAgentFiles } from './agents/built-in.js';
import { agentsMethods, loadBuiltInAgents } from './agents/definitions.js';
import { loadAssetTexts, useAssetTexts } from './assets.js';
import { compactThread } from './compact.js';
import { runPrompt } from './executor.js';
import {
  checkpoint,
  historyFormat,
  legacyHistoryFormat,
  rewind,
} from './history.js';
import type { BeforeModelRequest, DefaultPorts } from './ports.js';
import { createRunVariables } from './prompts/variables.js';
import {
  DEFAULT_HOOKS,
  routedBeforeModelRequest,
  routedPorts,
} from './routed.js';

/** What a test may replace; `main.ts` passes nothing. */
export interface DefaultHostOptions {
  /** The prompt date's clock; default `() => new Date()`. */
  readonly now?: () => Date;
  /** The built-in agent files; default `builtInAgentFiles()` after the assets are installed. */
  readonly builtInAgents?: readonly AgentFile[];
  /** Reads one asset; default `context.assets.read`. */
  readonly readAsset?: (path: string) => Promise<Uint8Array>;
}

export interface DefaultHost {
  /** Built at load with no I/O, so `main.ts` lists them statically. */
  readonly implementations: {
    /**
     * `executor/v1` = `serveExecutor(implementation, () => context.services.use(SessionService))`, where
     * `run` is `runPrompt(input, call, routedPorts, routedBeforeModelRequest, variables, builtIn)` with
     * `ports.images(input.session)`; `checkpoint`/`rewind` today's `history.ts`; `formats` `[historyFormat,
     * legacyHistoryFormat]` (no session call); `compact` `compactThread`. Failures: a thrown llms
     * `ProviderErrorObject` → `ContractError('provider_error', data.message, {providerError: data})`; a
     * `ToolErrorObject` → `ContractError('tool_error', data.message, {toolError: data})`; a `ContractError`
     * unchanged; others as the SDK answers them.
     * `run`'s `call.signal` aborts on a cancel through the session (`serveExecutor`); `runPrompt` stops on it and
     * records the history the run left through the still-open session; the `Run` then fails `run_cancelled` (or with
     * the `ContractError` the run threw, mapped as today). `compactThread`'s `call.signal` aborts on a cancel through
     * the session; the summarizer stops, `compaction.failed` is recorded through the still-open session and `Compact`
     * answers `{status: 'failed', code}` (`summarizer_failed`, or the `CompactionError`'s code) — or fails
     * `compaction_cancelled` for a non-`ContractError` thrown outside that step.
     * Before `activate` resolved every method fails `unavailable` ('default is not active.') without a call.
     */
    readonly executor: ServiceImpl<typeof ExecutorService>;
    /**
     * `default.agents/v1` over `agentsMethods(builtIn)` with `routedPorts`: `List{}` → `{agents}`, `Resolve{name}` →
     * `{agent}` (`not_found`, `invalid_definition` with today's details). `unavailable` before `activate`.
     */
    readonly agents: ServiceImpl<typeof AgentsService>;
  };
  /**
   * In order, each failure rejecting `activate` (nothing is served then):
   * 1. `loadAssetTexts(options.readAsset ?? context.assets.read)` → `useAssetTexts`;
   * 2. `loadBuiltInAgents(options.builtInAgents ?? builtInAgentFiles())` (today's Error for an invalid one);
   * 3. `context.registrations.track(HooksService, c => c.define({contract: 'default.hooks/v1'}))`;
   * 4. the services answer from then on.
   * Makes no other call: no `executor.session/v1`, `models/v1`, `tools/v1` call (s48 §7).
   */
  activate(context: HostContext): Promise<void>;
}

/** What the services read once `activate` resolved. */
interface Active {
  readonly context: HostContext;
  readonly ports: DefaultPorts;
  readonly beforeModelRequest: BeforeModelRequest;
  readonly builtIn: readonly AgentDefinition[];
  readonly agents: ReturnType<typeof agentsMethods>;
}

/** A run's failure as `executor/v1` answers it (see {@link DefaultHost}). */
const executorFailure = (error: unknown): unknown => {
  if (error instanceof ProviderErrorObject) {
    return new ContractError('provider_error', error.data.message, {
      providerError: error.data,
    });
  }
  if (error instanceof ToolErrorObject) {
    return new ContractError('tool_error', error.data.message, {
      toolError: error.data,
    });
  }
  return error;
};

/** Runs `work`, rethrowing its failure as {@link executorFailure} does. */
const mapped = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    throw executorFailure(error);
  }
};

/** An agent summary as `default.agents/v1` carries it. */
const summaryMessage = ({
  name,
  description,
  source,
  model,
  effort,
}: AgentSummary) => ({
  name,
  description,
  source,
  ...(model === undefined ? {} : { model }),
  ...(effort === undefined ? {} : { effort }),
});

/** No I/O; one per process. */
export const createDefaultHost = (
  options: DefaultHostOptions = {},
): DefaultHost => {
  const runVariables = createRunVariables(options.now ?? (() => new Date()));
  let active: Active | undefined;

  const current = (): Active => {
    if (active === undefined) {
      throw new ContractError('unavailable', 'default is not active.');
    }
    return active;
  };

  const executor = serveExecutor(
    {
      run: (input, call) =>
        mapped(() => {
          const { ports, beforeModelRequest, builtIn } = current();
          return runPrompt(
            input,
            call,
            ports,
            beforeModelRequest,
            runVariables,
            builtIn,
          );
        }),
      checkpoint: async (input) => {
        current();
        return await checkpoint(input);
      },
      rewind: async (input) => {
        current();
        return await rewind(input);
      },
      formats: () => {
        current();
        return [historyFormat, legacyHistoryFormat];
      },
      compact: (input, call) =>
        mapped(() => compactThread(input, call, current().ports)),
    },
    () => current().context.services.use(SessionService),
  );

  const agents: ServiceImpl<typeof AgentsService> = {
    list: async (_request, context) => {
      const { agents: methods, ports } = current();
      const listed = await methods.list(callOf(context), ports);
      return { agents: listed.map(summaryMessage) };
    },
    resolve: async ({ name }, context) => {
      const { agents: methods, ports } = current();
      const agent = await methods.resolve(name, callOf(context), ports);
      return {
        agentDefinition: {
          ...summaryMessage(agent),
          instructions: agent.instructions,
        },
      };
    },
  };

  return {
    implementations: { executor, agents },
    activate: async (context) => {
      useAssetTexts(
        await loadAssetTexts(
          options.readAsset ?? ((path) => context.assets.read(path)),
        ),
      );
      const builtIn = loadBuiltInAgents(
        options.builtInAgents ?? builtInAgentFiles(),
      );
      await context.registrations.track(HooksService, (client) =>
        client.define({ contract: DEFAULT_HOOKS }),
      );
      const ports = routedPorts(context);
      active = {
        context,
        ports,
        beforeModelRequest: routedBeforeModelRequest(context),
        builtIn,
        agents: agentsMethods(builtIn),
      };
    },
  };
};
