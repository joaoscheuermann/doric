import { createAgent, createToolCallStorage } from 'agent';

type AgentOptions = Parameters<typeof createAgent>[0];

import {
  type Call,
  type HookHandle,
  ModelsV1,
  type RegisteredTool,
  type Services,
  ToolsV1,
} from 'bundle/contracts';
import { ConfigurationV1 } from 'host-config/contracts';
import type { LlmProvider, ProviderMessage } from 'llms';
import { createMessageStorage } from 'messages';
import type {
  ExecutorRunInput,
  ExecutorRunResult,
  SpawnAgent,
} from 'runtime/contracts';
import {
  type BoundTool,
  createToolStorage,
  isBoundTool,
  ToolErrorObject,
  type ToolStorage,
} from 'tool';

import type { AgentSummary, DefaultHooksV1 } from '../contracts/index.js';
import { agentCatalog } from './agents/catalog.js';
import { effectiveAgents, readWorkspaceAgents } from './agents/definitions.js';
import { liveAgents } from './agents/live.js';
import { withAttachments } from './attachments.js';
import { compactionConfig, maybeCompactRun } from './compact.js';
import { isContextOverflowError } from './compaction/project.js';
import { coalesced } from './deltas.js';
import { input } from './envelope.js';
import { readMessages, readMeta, retainedKey, saved } from './history.js';
import {
  checkTemplate,
  loadTemplate,
  render,
  renderBlock,
} from './prompts/templates.js';
import {
  type PromptVariables,
  promptVariableNames,
  type RunVariables,
} from './prompts/variables.js';
import { skillCatalog } from './skills/catalog.js';
import { liveCatalog } from './skills/live.js';
import { LOAD_SKILL_TOOL, loadSkillTool } from './skills/load-skill.js';
import { CODING_WORKFLOW_SKILL } from './skills/loaded.js';
import {
  type CatalogSkill,
  type RunSkills,
  readRunSkills,
} from './skills/sources.js';
import { resolveToolConfigs } from './tool-config.js';

// Moved from agents/doric/src/lib/agents/direct/executor.ts (design 57 §5.3).
// Every history and event write goes through the runtime's PromptSession, which
// redacts, sanitizes, persists and publishes, and keeps the persistence retry.
// The run writes through `coalesced`, so streamed deltas reach the log merged.

/** `prompts/system.md`, checked at import against `promptVariableNames`; rendered per run. */
const systemTemplate = loadTemplate(
  new URL('./prompts/system.md', import.meta.url),
  promptVariableNames,
);

/** `prompts/agent.md`, checked at import against the two names it may cite. */
const agentTemplate = loadTemplate(
  new URL('./prompts/agent.md', import.meta.url),
  ['name', 'instructions'],
);

/**
 * The "# Agent: <name>" section for a Thread running as `agent`, without a
 * leading or trailing newline: `agentTemplate` with the agent's name and its
 * instructions, themselves rendered with the run's `variables`. Throws
 * `checkTemplate`'s Error, named `agent <name>`, when the instructions cite a
 * name outside `promptVariableNames`, use a partial or do not parse.
 */
const agentSection = (agent: SpawnAgent, variables: PromptVariables): string =>
  renderBlock(agentTemplate, {
    name: agent.name,
    instructions: render(
      checkTemplate(
        agent.instructions,
        promptVariableNames,
        `agent ${agent.name}`,
      ),
      variables,
    ),
  });

/**
 * The default agent's system prompt for `variables`:
 * `renderBlock(systemTemplate, variables)` when `section` is '', else that
 * text plus `\n\n${section}`. Used for human chats and delegated child chats
 * alike. Pure; does not throw.
 */
export const systemPromptWith = (
  variables: PromptVariables,
  section: string,
): string => {
  const system = renderBlock(systemTemplate, variables);
  return section === '' ? system : `${system}\n\n${section}`;
};

/**
 * What a restart interrupted a tool call with, handed back to the model as that
 * call's result. A provider refuses a history whose last assistant turn holds a
 * call with no result, which is exactly what a run stopped in the middle of a
 * tool leaves behind, and the call is answered rather than re-executed: a tool
 * that already ran may have changed the sandbox, so running it a second time
 * could apply the same edit twice, while this result lets the model decide for
 * itself whether the call is still worth making.
 */
const interruptedToolResult =
  'The host was restarted while this tool call was running, so its result was lost. ' +
  'Call it again if you still need it.';

/**
 * Repairs a history a restart left in the middle of a tool call, by answering
 * every call of its trailing assistant turn that has no result yet.
 */
const repaired = (
  messages: readonly ProviderMessage[],
): readonly ProviderMessage[] => {
  let index = messages.length - 1;
  const answered = new Set<string>();
  while (messages[index]?.role === 'tool') {
    const id = messages[index]?.toolCallId;
    if (id !== undefined) answered.add(id);
    index -= 1;
  }
  const last = messages[index];
  const pending =
    last?.role === 'assistant'
      ? (last.toolCalls ?? []).filter((call) => !answered.has(call.id))
      : [];
  if (pending.length === 0) return messages;
  return [
    ...messages,
    ...pending.map((call) => ({
      role: 'tool' as const,
      toolCallId: call.id,
      content: interruptedToolResult,
      toolResultStatus: 'incomplete' as const,
    })),
  ];
};

/**
 * Whether one streamed event means the provider history just grew past the input
 * this run started with. The agent stores an assistant turn before it yields
 * `response.finished` and records a tool result before it yields `tool.finished`,
 * so those two events are the points where the work a resumed run must not lose
 * — the turns it already had answered and the tool results it already held — is
 * written down. A steering message is stored before `agent.steered` too, so
 * its history is saved before the event that tells the runtime it was taken
 * in. The input is no save point of its own: the accepted event already carries
 * its text and the prompt's checkpoint says whether it is in the stored
 * history, so a run that died before its first response resumes with the same
 * history either way. A failed tool grows nothing at all, which is what the
 * repair above answers.
 */
const addedMessages = (value: { readonly type: string }): boolean =>
  value.type === 'response.finished' ||
  value.type === 'tool.finished' ||
  value.type === 'agent.steered';

/**
 * Whether a failed tool call failed only because the generation process that
 * ran it exited. The host aborts the run of every prompt pinned to that
 * generation before the call rejects, so the failure is the crash itself, not
 * something the tool did.
 */
const generationLost = (error: unknown): boolean => {
  if (
    !(error instanceof ToolErrorObject) ||
    error.data.code !== 'handler_failed'
  )
    return false;
  for (
    let cause: unknown = error.cause;
    cause instanceof Error;
    cause = cause.cause
  ) {
    if ((cause as { code?: unknown }).code === 'generation_lost') return true;
  }
  return false;
};

/**
 * The run's tools with `load_skill` left out of `definitions()` until
 * `listed()` first holds a skill, and offered from then on, so a run with no
 * skill to load sends no such tool. Every other method delegates.
 */
const offeringSkills = (
  storage: ToolStorage,
  listed: () => ReadonlyMap<string, CatalogSkill>,
): ToolStorage => {
  let offered = false;
  return {
    definitions: () => {
      offered ||= listed().size > 0;
      const definitions = storage.definitions();
      return offered
        ? definitions
        : definitions.filter(({ name }) => name !== LOAD_SKILL_TOOL);
    },
    calls: (turn) => storage.calls(turn),
    validate: (call) => storage.validate(call),
    get: (name) => storage.get(name),
    execute: (call) => storage.execute(call),
  };
};

/** The tools of the prompt's generation; each must be one `defineTool` bound. */
const boundTools = (tools: readonly RegisteredTool[]): readonly BoundTool[] =>
  tools.map(({ tool }) => {
    if (!isBoundTool(tool))
      throw new TypeError(
        `Tool "${tool.name}" was not defined with defineTool.`,
      );
    return tool;
  });

/**
 * Runs one prompt input, retaining provider-ready history for its Thread
 * through the runtime's session. Every tool the bundles registered is offered,
 * in bundle order, and each tool runs under the prompt's call. The run's
 * skills are read at its start: the always-available bodies and the lists of
 * skills to load make the system prompt's `# Skills` section, which stays the
 * same for the whole run. Before every request after the first, the working
 * directory and the MCP servers are read again and a change reaches the model
 * as one "Skills changed" bundle instruction. The run's own `load_skill` tool,
 * last and offered once a skill can be loaded, loads a listed one, answers a
 * note for one the history already holds unchanged, and is exempt from the
 * tool result cap. A compaction keeps the skills it condensed away in one
 * retained "Loaded skills" message and makes the next check compare with the
 * system prompt's lists again.
 * Before every model request the system prompt passes through
 * `onBeforeModelRequestHook`, under the prompt's call. A standing
 * instruction (a retained bundle steer) is recorded in `meta.retained` when
 * the run stores it, so compaction keeps it.
 * The run's prompt variables are read once at its start, through `variables`,
 * and stay the same for the whole run.
 * At its start the run also reads the agents of `thread.cwd` (`builtInAgents`
 * and the workspace's own, in parallel with the skills reads); their
 * `# Agents` section goes before `# Skills`. Before every request after the
 * first, a change of the agents with the working directory reaches the model
 * as one "Agents changed" bundle instruction, given before the "Skills
 * changed" one. A compaction makes the next check compare with the system
 * prompt's agents again.
 * The run resolves `thread.model ?? execution.model` and `thread.effort ??
 * execution.effort` on `execution.providerId` once, for its agent loop and its
 * automatic compaction; manual compaction (`compactThread`) keeps the
 * execution model. A Thread running as an agent gets its `agentSection` before
 * `# Agents`, is not offered the coding workflow skill
 * (`CODING_WORKFLOW_SKILL`), and on invalid instructions rejects with
 * `agentSection`'s Error before its first model request.
 */
export const runPrompt = async (
  { thread, job, session }: ExecutorRunInput,
  call: Call,
  services: Services,
  hooks: HookHandle<typeof DefaultHooksV1>,
  variables: RunVariables,
  builtInAgents: readonly AgentSummary[],
): Promise<Readonly<Pick<ExecutorRunResult, 'text'>>> => {
  const signal = call.signal;
  signal.throwIfAborted();
  // Every write of the run, the compaction's included, so a held run of
  // deltas is written before anything that follows it.
  const log = coalesced(session);
  const stored = await readMessages(session.history);
  // The map the compaction rewrite re-bases when it condenses this run's
  // history: `history()` reads the current value, so every later save
  // carries the re-based boundaries.
  let { checkpoints, retained } = await readMeta(session.history);
  const boundary = checkpoints[job.id];
  const resume = boundary !== undefined && stored.length > boundary;
  const { configuration } = await services.use(ConfigurationV1).current(call);
  const runVariables = variables(
    thread.projectId,
    configuration.profile,
    call,
    services,
  );
  const compaction = compactionConfig(configuration);
  // `list` answers a promise when tools/v1 is in another process.
  const tools = boundTools(await services.use(ToolsV1).list(call));
  const [read, workspaceAgents] = await Promise.all([
    readRunSkills(thread.cwd, call, services),
    readWorkspaceAgents(thread.cwd, call, services),
  ]);
  // A Thread running as an agent is not offered the coding workflow: its
  // agent's instructions are its workflow.
  const skills: RunSkills =
    thread.agent === undefined
      ? read
      : {
          ...read,
          builtIn: read.builtIn.filter(
            ({ name }) => name !== CODING_WORKFLOW_SKILL,
          ),
        };
  const catalog = skillCatalog(skills);
  const live = liveCatalog(
    { cwd: thread.cwd, skills, catalog },
    call,
    services,
  );
  const agents = effectiveAgents(builtInAgents, workspaceAgents);
  const agentsLive = liveAgents(
    { cwd: thread.cwd, agents },
    builtInAgents,
    call,
    services,
  );
  const execution = configuration.models.execution;
  const model = thread.model ?? execution.model;
  const effort = thread.effort ?? execution.effort;
  const { languageModel } = await services.use(ModelsV1).resolve(
    {
      providerId: execution.providerId,
      model,
      ...(effort === undefined ? {} : { effort }),
    },
    call,
  );
  const textProvider = languageModel as unknown as LlmProvider;
  // The run reads attachments through its session; compaction keeps the
  // reference lines as text, so a summary never carries image bytes.
  const attachment = session.attachment?.bind(session);
  const provider =
    attachment === undefined
      ? textProvider
      : withAttachments(textProvider, attachment);
  const messages = createMessageStorage(repaired(stored));
  /**
   * The retained steers the run took and has not found in its storage yet,
   * by the exact text the agent stores for each.
   */
  const retaining = new Map<string, string>();
  /** Records where each retained steer the agent stored now sits. */
  const settle = () => {
    if (retaining.size === 0) return;
    const list = messages.list();
    for (let at = list.length - 1; at >= 0 && retaining.size > 0; at -= 1) {
      const message = list[at];
      const content = message?.role === 'user' ? message.content : undefined;
      const key =
        typeof content === 'string' ? retaining.get(content) : undefined;
      if (key === undefined || typeof content !== 'string') continue;
      retained = { ...retained, [key]: at };
      retaining.delete(content);
    }
  };
  /**
   * The history the run has built so far. A resumed run reads it back and
   * continues from what it holds, so it is saved wherever it moved on rather
   * than only when the run ends; a run that ends also writes what it left, so a
   * paused prompt is durable before its pause is recorded.
   */
  const history = () => {
    settle();
    return saved(messages.list(), checkpoints, retained);
  };
  const promptVariables = await runVariables;
  const base = systemPromptWith(
    promptVariables,
    [
      thread.agent === undefined
        ? ''
        : agentSection(thread.agent, promptVariables),
      agentCatalog(agents),
      catalog.section,
    ]
      .filter((section) => section !== '')
      .join('\n\n'),
  );
  const agent = createAgent({
    provider,
    model,
    effort: effort as AgentOptions['effort'],
    system: async () =>
      (await hooks.onBeforeModelRequestHook.execute({ system: base }, call))
        .system,
    tools: offeringSkills(
      createToolStorage(
        (() => {
          // Tool values reach tools through settings/v1 from stage 2; resolving
          // them here still refuses a prompt whose tool settings are unmet.
          resolveToolConfigs(tools, configuration);

          return [
            ...tools.map((tool) => tool.toTool(call)),
            loadSkillTool(
              () => live.listed(),
              () => messages.list(),
              call,
              services,
            ),
          ];
        })(),
      ),
      () => live.listed(),
    ),
    toolCalls: createToolCallStorage(),
    messages,
  });
  let text = '';
  /** Set once the first request was made: the agents and skills are checked before every later one. */
  let checked = false;
  /** Set once the run's generation process was lost; see below. */
  let lost = false;
  /** The last response's reported usage and window, for the projection. */
  let lastInputTokens: number | undefined;
  let lastOutputTokens: number | undefined;
  let contextWindow: number | undefined;
  /** Set once an overflow forced a condensation, so the run forces only one. */
  let overflowCondensed = false;
  const condenseOverflow = async () => {
    if (overflowCondensed) return;
    overflowCondensed = true;
    await compactIfUnderPressure(0, true);
  };
  /**
   * One compaction attempt between turns: skips or refuses without
   * recording anything, condenses and re-bases the checkpoint map when it
   * runs. The pre-run call projects the pending prompt on top of the
   * resumed history; the between-turn calls project with real usage.
   */
  const compactIfUnderPressure = async (promptChars: number, force = false) => {
    settle();
    const result = await maybeCompactRun({
      session: log,
      messages,
      checkpoints,
      retained,
      config: compaction,
      provider: textProvider,
      model,
      promptChars,
      ...(lastInputTokens === undefined ? {} : { lastInputTokens }),
      ...(lastOutputTokens === undefined ? {} : { lastOutputTokens }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      force,
      signal,
    });
    if (result.status === 'compacted') {
      checkpoints = result.checkpoints;
      retained = result.retained;
      // A change message the summary replaced is told again.
      live.rebase();
      agentsLive.rebase();
    }
  };
  // A long resumed history plus this run's input is the classic overflow:
  // measure it before the first provider call of the run.
  await compactIfUnderPressure(input(job).length);
  try {
    for await (const value of agent.stream(input(job), {
      resume,
      signal,
      maxTurns: configuration.execution.maxTurns,
      // A loaded skill reaches the model whole; its own cap bounds it.
      maxToolResultChars: (name) =>
        name === LOAD_SKILL_TOOL
          ? undefined
          : configuration.execution.maxToolResultChars,
      beforeRequest: async () => {
        // The first request reads the agents and skills the system prompt lists.
        if (!checked) {
          checked = true;
          return [];
        }
        const changes = await Promise.all([
          agentsLive.refresh(),
          live.refresh(),
        ]);
        return changes.filter((change) => change !== undefined);
      },
      ...(session.steers === undefined
        ? {}
        : {
            // Each steer reaches the model in its source's envelope: the
            // reader's request, a child's result or a terminal's output.
            steering: async () =>
              ((await session.steers?.()) ?? []).map(({ prompt, source }) => {
                const text = input({ prompt, source });
                if (source.kind === 'bundle' && source.retain === true)
                  retaining.set(
                    text,
                    retainedKey(source.bundleId, source.reason),
                  );
                return text;
              }),
          }),
    })) {
      if (
        value.type === 'tool.failed' &&
        signal.aborted &&
        generationLost(value.error)
      ) {
        // The generation process died under this tool call. The history is
        // kept exactly as a host crash leaves it — the call without a result,
        // which the resumed run answers with the interrupted-call result — so
        // it is saved now, before the agent answers the call itself, and the
        // failure is not recorded: the run pauses instead.
        lost = true;
        await log.record({ history: history() });
        throw signal.reason;
      }
      if (value.type === 'response.started') {
        contextWindow = value.contextWindow ?? contextWindow;
      }
      if (value.type === 'usage') {
        lastInputTokens = value.usage.inputTokens;
        lastOutputTokens = value.usage.outputTokens;
      }
      const event =
        value.type === 'response.started'
          ? { ...value, providerId: execution.providerId }
          : value;
      await log.record(
        addedMessages(value) ? { history: history(), event } : { event },
      );
      // The pressure only moves once a turn has finished: its usage is final
      // then, and the check runs before the agent builds its next request
      // from the storage. A `usage` event can arrive while the provider is
      // still streaming (Claude reports one at `message_start`), and a
      // condensation then would rewrite the history the turn was answering.
      if (value.type === 'response.finished') {
        await compactIfUnderPressure(0);
      }
      if (value.type === 'error' && isContextOverflowError(value.error)) {
        // The window the provider refused is proof the pressure exists. The
        // emergency condensation prepares the next resume; this run still
        // fails with the provider's error, as it does without the check.
        await condenseOverflow();
      }
      signal.throwIfAborted();
      if (value.type === 'agent.finished') text = value.response.text;
    }
    return { text };
  } catch (error) {
    if (isContextOverflowError(error)) {
      await condenseOverflow().catch(() => undefined);
    }
    throw error;
  } finally {
    // The run ended, so whatever it left — complete or partial — is the history
    // its Thread carries on with, after the deltas it still held.
    if (!lost) await log.record({ history: history() });
  }
};
