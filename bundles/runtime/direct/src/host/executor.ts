import { createAgent, createToolCallStorage } from 'agent';

type AgentOptions = Parameters<typeof createAgent>[0];

import {
  type Call,
  ModelsV1,
  type RegisteredTool,
  type Services,
  type SkillRecord,
  SkillsV1,
  ToolsV1,
} from 'bundle/contracts';
import { ConfigurationV1 } from 'host-config/contracts';
import type { LlmProvider, ProviderMessage } from 'llms';
import { createMessageStorage } from 'messages';
import type {
  ExecutorRunInput,
  ExecutorRunResult,
  PromptJob,
} from 'runtime/contracts';
import {
  type BoundTool,
  createToolStorage,
  isBoundTool,
  ToolErrorObject,
} from 'tool';

import { readMessages, readMeta, saved } from './history.js';
import { systemPrompt } from './prompts/system.js';
import { resolveToolConfigs } from './tool-config.js';

// Moved from agents/doric/src/lib/agents/direct/executor.ts (design 57 §5.3).
// Every history and event write goes through the runtime's PromptSession, which
// redacts, sanitizes, persists and publishes, and keeps the persistence retry.

/** Common Direct policy for human chats and delegated child chats. */
export const directSystemPrompt = (
  skills: readonly Pick<SkillRecord, 'name' | 'body'>[],
): string => {
  let prompt = systemPrompt;
  for (const { name, body } of skills) {
    prompt += `

## Skill: ${name}

${body}`;
  }
  return prompt;
};

const input = (job: PromptJob): string => {
  const source = job.source;
  const label =
    source.kind === 'user'
      ? 'User request'
      : source.kind === 'parent'
        ? `Parent instruction from thread ${source.threadId}, prompt ${source.promptId}`
        : source.kind === 'terminal'
          ? `Background terminal ${source.terminalId}, originating prompt ${source.promptId}`
          : `Child result from thread ${source.threadId}, prompt ${source.promptId}`;
  return `# ${label}

${job.prompt}`;
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
 * written down. The input is no save point of its own: the accepted event
 * already carries its text and the prompt's checkpoint says whether it is in the
 * stored history, so a run that died before its first response resumes with the
 * same history either way. A failed tool grows nothing at all, which is what the
 * repair above answers.
 */
const addedMessages = (value: { readonly type: string }): boolean =>
  value.type === 'response.finished' || value.type === 'tool.finished';

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
 * through the runtime's session. Every tool and skill the bundles registered
 * is offered, in bundle order, and each tool runs under the prompt's call.
 */
export const runDirect = async (
  { job, session }: ExecutorRunInput,
  call: Call,
  services: Services,
): Promise<Readonly<Pick<ExecutorRunResult, 'text'>>> => {
  const signal = call.signal;
  signal.throwIfAborted();
  const stored = await readMessages(session.history);
  const { checkpoints } = await readMeta(session.history);
  const boundary = checkpoints[job.id];
  const resume = boundary !== undefined && stored.length > boundary;
  const { configuration } = await services.use(ConfigurationV1).current(call);
  // `list` answers a promise when tools/v1 is in another process.
  const tools = boundTools(await services.use(ToolsV1).list(call));
  const skills = (await services.use(SkillsV1).list(call)).map(
    ({ skill }) => skill,
  );
  const execution = configuration.models.execution;
  const { languageModel } = await services.use(ModelsV1).resolve(
    {
      providerId: execution.providerId,
      model: execution.model,
      ...(execution.effort === undefined ? {} : { effort: execution.effort }),
    },
    call,
  );
  const provider = languageModel as unknown as LlmProvider;
  const messages = createMessageStorage(repaired(stored));
  /**
   * The history the run has built so far. A resumed run reads it back and
   * continues from what it holds, so it is saved wherever it moved on rather
   * than only when the run ends; a run that ends also writes what it left, so a
   * paused prompt is durable before its pause is recorded.
   */
  const history = () => saved(messages.list(), checkpoints);
  const agent = createAgent({
    provider,
    model: execution.model,
    effort: execution.effort as AgentOptions['effort'],
    system: directSystemPrompt(skills),
    tools: createToolStorage(
      (() => {
        // Tool values reach tools through settings/v1 from stage 2; resolving
        // them here still refuses a prompt whose tool settings are unmet.
        resolveToolConfigs(tools, configuration);

        return tools.map((tool) => tool.toTool(call));
      })(),
    ),
    toolCalls: createToolCallStorage(),
    messages,
  });
  let text = '';
  /** Set once the run's generation process was lost; see below. */
  let lost = false;
  try {
    for await (const value of agent.stream(input(job), {
      resume,
      signal,
      maxTurns: configuration.execution.maxTurns,
      maxToolResultChars: configuration.execution.maxToolResultChars,
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
        await session.record({ history: history() });
        throw signal.reason;
      }
      const event =
        value.type === 'response.started'
          ? { ...value, providerId: execution.providerId }
          : value;
      await session.record(
        addedMessages(value) ? { history: history(), event } : { event },
      );
      signal.throwIfAborted();
      if (value.type === 'agent.finished') text = value.response.text;
    }
    return { text };
  } finally {
    // The run ended, so whatever it left — complete or partial — is the history
    // its Thread carries on with.
    if (!lost) await session.record({ history: history() });
  }
};
