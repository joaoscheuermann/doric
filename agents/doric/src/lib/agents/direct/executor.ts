import { createAgent, createToolCallStorage } from 'agent';
import type { Skill } from 'bundle';
import type { ProviderMessage } from 'llms';
import { createMessageStorage } from 'messages';
import { createToolStorage } from 'tool';

import { providerFor } from '../../config/generation.js';
import { resolveToolConfigs } from '../../config/tool-config.js';
import { eventJson } from '../../events/serialization.js';
import {
  type PromptJob,
  type ThreadExecution,
  ThreadPersistenceError,
} from '../../workspace/runtime.js';
import { systemPrompt } from './prompts/system.js';

/** Common Direct policy for human chats and delegated child chats. */
export const directSystemPrompt = (skills: readonly Skill[]): string => {
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
 * already carries its text and `checkpoints[promptId]` says whether it is in the
 * stored history, so a run that died before its first response resumes with the
 * same history either way. A failed tool grows nothing at all, which is what the
 * repair above answers.
 */
const addedMessages = (value: { readonly type: string }): boolean =>
  value.type === 'response.finished' || value.type === 'tool.finished';

/** Runs one input, retaining provider-ready history independently for each Thread. */
export const runDirectPrompt: ThreadExecution = async ({
  thread,
  job,
  generation,
  sandbox,
  signal,
  store,
  publisher,
  host,
}) => {
  signal.throwIfAborted();
  const record = await store.find(thread.id).catch((cause) => {
    throw new ThreadPersistenceError(cause);
  });
  if (record === undefined) throw new Error('Thread no longer exists.');
  const boundary = record.checkpoints[job.id];
  const resume = boundary !== undefined && record.messages.length > boundary;
  const messages = createMessageStorage(repaired(record.messages));
  /**
   * Writes the history the run has built so far. A resumed run reads it back and
   * continues from what it holds, so it is saved wherever it moved on rather
   * than only when the run ends; a run that ends also writes what it left, so a
   * paused prompt is durable before its pause is recorded.
   */
  const save = async () => {
    try {
      await store.saveMessages(
        thread.id,
        eventJson(
          messages.list(),
          generation.redactions(),
        ) as readonly ProviderMessage[],
      );
    } catch (cause) {
      throw new ThreadPersistenceError(cause);
    }
  };
  const execution = generation.snapshot.configuration.models.execution;
  const agent = createAgent({
    provider: providerFor(generation, execution.providerId),
    model: execution.model,
    effort: execution.effort,
    system: directSystemPrompt(generation.catalog.skills),
    tools: createToolStorage(
      (() => {
        const configs = resolveToolConfigs(
          generation.catalog.tools,
          generation.snapshot.configuration,
        );

        return generation.catalog.tools.map((factory) =>
          factory(sandbox, host, configs.get(factory.name)),
        );
      })(),
    ),
    toolCalls: createToolCallStorage(),
    messages,
  });
  let text = '';
  try {
    for await (const value of agent.stream(input(job), {
      resume,
      signal,
      maxTurns: generation.snapshot.configuration.execution.maxTurns,
      maxToolResultChars:
        generation.snapshot.configuration.execution.maxToolResultChars,
    })) {
      try {
        if (addedMessages(value)) await save();
        const stored = await store.appendEvent(
          thread.id,
          job.id,
          eventJson(
            value.type === 'response.started'
              ? { ...value, providerId: execution.providerId }
              : value,
            generation.redactions(),
          ),
        );
        publisher.event(stored);
      } catch (cause) {
        throw new ThreadPersistenceError(cause);
      }
      signal.throwIfAborted();
      if (value.type === 'agent.finished') text = value.response.text;
    }
    return text;
  } finally {
    // The run ended, so whatever it left — complete or partial — is the history
    // its Thread carries on with.
    await save();
  }
};
