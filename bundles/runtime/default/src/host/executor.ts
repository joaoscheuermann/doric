import { createAgent, createToolCallStorage } from 'agent';

type AgentOptions = Parameters<typeof createAgent>[0];

import {
  type Call,
  type HookHandle,
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

import type { DefaultHooksV1 } from '../contracts/index.js';
import { withAttachments } from './attachments.js';
import { compactionConfig, maybeCompactRun } from './compact.js';
import { isContextOverflow } from './compaction/project.js';
import { readMessages, readMeta, saved } from './history.js';
import { systemPrompt } from './prompts/system.js';
import { resolveToolConfigs } from './tool-config.js';

// Moved from agents/doric/src/lib/agents/direct/executor.ts (design 57 §5.3).
// Every history and event write goes through the runtime's PromptSession, which
// redacts, sanitizes, persists and publishes, and keeps the persistence retry.

/** Common default-agent policy for human chats and delegated child chats. */
export const systemPromptWith = (
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

const envelopeTags = [
  'user-request',
  'parent-instruction',
  'terminal-output',
  'child-result',
] as const;

const closingTags = new RegExp(`</(${envelopeTags.join('|')})`, 'gi');

const attribute = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;');

/**
 * Wraps the prompt in the XML envelope that names where the input came from.
 * Only the attribute values are escaped; the body stays as written, except that
 * a literal closing envelope tag is defused so the text cannot end the
 * envelope early. A plain-text prompt (older history, no inner tags) is
 * wrapped unchanged.
 */
const input = (job: PromptJob): string => {
  const source = job.source;
  const [tag, attributes] =
    source.kind === 'user'
      ? (['user-request', ''] as const)
      : source.kind === 'parent'
        ? ([
            'parent-instruction',
            ` thread="${attribute(source.threadId)}" prompt="${attribute(source.promptId)}"`,
          ] as const)
        : source.kind === 'terminal'
          ? ([
              'terminal-output',
              ` terminal="${attribute(source.terminalId)}" prompt="${attribute(source.promptId)}"`,
            ] as const)
          : ([
              'child-result',
              ` thread="${attribute(source.threadId)}" prompt="${attribute(source.promptId)}"`,
            ] as const);
  const body = job.prompt.replace(closingTags, '<\\/$1');
  return `<${tag}${attributes}>
${body}
</${tag}>`;
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
 * Before every model request the system prompt passes through
 * `onBeforeModelRequestHook`, under the prompt's call.
 */
export const runPrompt = async (
  { job, session }: ExecutorRunInput,
  call: Call,
  services: Services,
  hooks: HookHandle<typeof DefaultHooksV1>,
): Promise<Readonly<Pick<ExecutorRunResult, 'text'>>> => {
  const signal = call.signal;
  signal.throwIfAborted();
  const stored = await readMessages(session.history);
  // The map the compaction rewrite re-bases when it condenses this run's
  // history: `history()` reads the current value, so every later save
  // carries the re-based boundaries.
  let { checkpoints } = await readMeta(session.history);
  const boundary = checkpoints[job.id];
  const resume = boundary !== undefined && stored.length > boundary;
  const { configuration } = await services.use(ConfigurationV1).current(call);
  const compaction = compactionConfig(configuration);
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
   * The history the run has built so far. A resumed run reads it back and
   * continues from what it holds, so it is saved wherever it moved on rather
   * than only when the run ends; a run that ends also writes what it left, so a
   * paused prompt is durable before its pause is recorded.
   */
  const history = () => saved(messages.list(), checkpoints);
  const base = systemPromptWith(skills);
  const agent = createAgent({
    provider,
    model: execution.model,
    effort: execution.effort as AgentOptions['effort'],
    system: async () =>
      (await hooks.onBeforeModelRequestHook.execute({ system: base }, call))
        .system,
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
  /** The last response's reported usage and window, for the projection. */
  let lastInputTokens: number | undefined;
  let lastOutputTokens: number | undefined;
  let contextWindow: number | undefined;
  /**
   * One compaction attempt between turns: skips or refuses without
   * recording anything, condenses and re-bases the checkpoint map when it
   * runs. The pre-run call projects the pending prompt on top of the
   * resumed history; the between-turn calls project with real usage.
   */
  const compactIfUnderPressure = async (promptChars: number, force = false) => {
    const result = await maybeCompactRun({
      session,
      messages,
      checkpoints,
      config: compaction,
      provider: textProvider,
      model: execution.model,
      promptChars,
      ...(lastInputTokens === undefined ? {} : { lastInputTokens }),
      ...(lastOutputTokens === undefined ? {} : { lastOutputTokens }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      force,
      signal,
    });
    if (result.status === 'compacted') checkpoints = result.checkpoints;
  };
  // A long resumed history plus this run's input is the classic overflow:
  // measure it before the first provider call of the run.
  await compactIfUnderPressure(input(job).length);
  try {
    for await (const value of agent.stream(input(job), {
      resume,
      signal,
      maxTurns: configuration.execution.maxTurns,
      maxToolResultChars: configuration.execution.maxToolResultChars,
      ...(session.steers === undefined
        ? {}
        : {
            // Each steer reaches the model in its source's envelope: the
            // reader's request, a child's result or a terminal's output.
            steering: async () =>
              ((await session.steers?.()) ?? []).map(({ prompt, source }) =>
                input({ id: job.id, prompt, source }),
              ),
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
        await session.record({ history: history() });
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
      await session.record(
        addedMessages(value) ? { history: history(), event } : { event },
      );
      // The pressure only moves where usage lands: the provider window grew
      // by this turn's tokens, so the check rides the usage and finished
      // events, before the agent builds its next request from the storage.
      if (value.type === 'usage' || value.type === 'response.finished') {
        await compactIfUnderPressure(0);
      }
      if (
        value.type === 'error' &&
        isContextOverflow(String(value.error.message ?? ''))
      ) {
        // The window the provider refused is proof the pressure exists. The
        // emergency condensation prepares the next resume; this run still
        // fails with the provider's error, as it does without the check.
        await compactIfUnderPressure(0, true);
      }
      signal.throwIfAborted();
      if (value.type === 'agent.finished') text = value.response.text;
    }
    return { text };
  } catch (error) {
    if (isContextOverflow(String((error as Error)?.message ?? error))) {
      await compactIfUnderPressure(0, true).catch(() => undefined);
    }
    throw error;
  } finally {
    // The run ended, so whatever it left — complete or partial — is the history
    // its Thread carries on with.
    if (!lost) await session.record({ history: history() });
  }
};
