// Public contracts of the `default` bundle. It provides `executor/v1`, which
// the `runtime` bundle owns (D-S6-04), and owns `default.hooks/v1` and
// `default.agents/v1`.

import {
  type CallArg,
  defineHook,
  defineHooks,
  type MethodSpecs,
  noInput,
  ref,
} from 'bundle/contracts';
import {
  type ReasoningEffort,
  reasoningEfforts,
  spawnInstructionsMaxLength,
  type ThreadAgentSource,
} from 'runtime/contracts';
import { z } from 'zod';

/**
 * default.hooks/v1: `onBeforeModelRequestHook` runs before every model
 * request of a prompt, so a handler can adjust the system prompt to the state
 * the Thread is in at that turn. `call.scope` names the prompt (`projectId`,
 * `threadId`, `promptId`) and `call.signal` aborts with it.
 */
export const DefaultHooksV1 = defineHooks('default.hooks/v1', {
  onBeforeModelRequestHook: defineHook({
    kind: 'transform',
    input: z.object({ system: z.string() }).strict(),
  }),
});

/**
 * An agent's name: 1–64 characters, lowercase ASCII letters, digits, `_` and
 * `-`, starting with a letter or digit. A workspace agent's name is its file
 * name `<name>.md` in `.agents/agents`; a file whose base name does not match
 * defines no agent.
 */
export const agentNamePattern = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

/**
 * One agent a Thread can be spawned as, without its instructions.
 * - `name`: matches `agentNamePattern`; unique among the agents `list` answers.
 * - `description`: when to use the agent, from its frontmatter; never blank.
 * - `source`: `built-in` when it ships with the `default` bundle, `workspace`
 *   when it comes from `<cwd>/.agents/agents/<name>.md`.
 * - `model`, `effort`: the frontmatter's values, absent when missing or blank.
 *   `effort` is always one of `reasoningEfforts`. Whether the model accepts it
 *   is the executor's concern.
 */
export interface AgentSummary {
  readonly name: string;
  readonly description: string;
  readonly source: ThreadAgentSource;
  readonly model?: string;
  readonly effort?: ReasoningEffort;
}

/**
 * An agent with its instructions: the text after the frontmatter, trimmed.
 * The instructions are a raw mustache template that may cite only the prompt
 * variables (`os`, `date`, `timezone`, `user`, `user.name`). Nothing is
 * rendered yet. The definition file is at most `spawnInstructionsMaxLength`
 * UTF-8 bytes, so the instructions always fit a spawn.
 */
export interface AgentDefinition extends AgentSummary {
  readonly instructions: string;
}

const agentSummaryShape = {
  name: z.string().regex(agentNamePattern),
  description: z.string().min(1),
  source: z.enum(['built-in', 'workspace']),
  model: z.string().min(1).optional(),
  effort: z.enum(reasoningEfforts).optional(),
};

export const agentSummarySchema: z.ZodType<AgentSummary, AgentSummary> = z
  .object(agentSummaryShape)
  .strict();

export const agentDefinitionSchema: z.ZodType<
  AgentDefinition,
  AgentDefinition
> = z
  .object({
    ...agentSummaryShape,
    instructions: z.string().max(spawnInstructionsMaxLength),
  })
  .strict();

export const agentSummariesSchema: z.ZodType<
  readonly AgentSummary[],
  readonly AgentSummary[]
> = z.array(agentSummarySchema);

/**
 * default.agents/v1: the agents a Thread can be spawned as. The built-in
 * agents ship with the `default` bundle. The workspace agents are the
 * `<name>.md` files of `.agents/agents` in the Thread's current working
 * directory (`runtime.workspace/v1` `cwd` under `call.scope`). Host-only:
 * no method is exposed to a window.
 */
export interface DefaultAgents {
  /**
   * The agents defined now. A valid workspace agent replaces the built-in of
   * the same name. An invalid workspace file is left out, and it still hides
   * the built-in of the same name. Order: the built-ins that are not hidden,
   * in shipped order, then the valid workspace agents in file-name (sorted)
   * order. With no known working directory: the built-ins only. A sandbox
   * that cannot be scanned counts as having no workspace agents. Never
   * rejects because of the workspace.
   */
  list(call?: CallArg): Promise<readonly AgentSummary[]>;
  /**
   * The full definition of `name`, chosen by the same rule as `list`. The
   * file is read whole and checked again. Fails with a `ContractError`:
   * - `invalid_input`: `name` does not match `agentNamePattern`, or `input`
   *   has another key (schema check, before any read).
   * - `not_found`: `Agent "<name>" is not defined. Defined agents: <a>, <b>.`,
   *   or `… No agent is defined.`; details `{ name, agents }`.
   * - `invalid_definition`: the workspace file exists but is invalid or
   *   cannot be read: `Agent "<name>" is invalid: <reason>.`; details
   *   `{ name, path, reason }`.
   * Holds: for an unchanged workspace, `resolve` succeeds for exactly the
   * names `list` answers, except a file longer than 4096 bytes whose
   * instructions cite a non-variable name (listed, then `invalid_definition`).
   */
  resolve(
    input: { readonly name: string },
    call?: CallArg,
  ): Promise<AgentDefinition>;
}

export const defaultAgentsMethods = {
  list: { input: noInput, output: agentSummariesSchema },
  resolve: {
    input: z.object({ name: z.string().regex(agentNamePattern) }).strict(),
    output: agentDefinitionSchema,
  },
} as const satisfies MethodSpecs;

/** default.agents/v1, as the `default` bundle provides it. */
export const DefaultAgentsV1 = ref<DefaultAgents>('default.agents/v1');
