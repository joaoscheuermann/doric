import { createAgent, createToolCallStorage } from 'agent';
import type { Skill } from 'bundle';
import type { ProviderMessage } from 'llms';
import { createMessageStorage } from 'messages';
import { createToolStorage } from 'tool';

import { eventJson } from '../../events/serialization.js';
import { providerFor } from '../../config/generation.js';
import {
  ThreadPersistenceError,
  type PromptJob,
  type ThreadExecution,
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
        : `Child result from thread ${source.threadId}, prompt ${source.promptId}`;
  return `# ${label}

${job.prompt}`;
};

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
  const record = await store.find(thread.id).catch(() => {
    throw new ThreadPersistenceError();
  });
  if (record === undefined) throw new Error('Thread no longer exists.');
  const messages = createMessageStorage(record.messages);
  const execution = generation.snapshot.configuration.models.execution;
  const agent = createAgent({
    provider: providerFor(generation, execution.providerId),
    model: execution.model,
    effort: execution.effort,
    system: directSystemPrompt(generation.catalog.skills),
    tools: createToolStorage(
      generation.catalog.tools.map((factory) => factory(sandbox, host)),
    ),
    toolCalls: createToolCallStorage(),
    messages,
  });
  let text = '';
  try {
    for await (const value of agent.stream(input(job), {
      signal,
      maxTurns: generation.snapshot.configuration.execution.maxTurns,
    })) {
      try {
        const stored = await store.appendEvent(
          thread.id,
          job.id,
          eventJson(value, generation.redactions()),
        );
        publisher.event(stored);
      } catch {
        throw new ThreadPersistenceError();
      }
      signal.throwIfAborted();
      if (value.type === 'agent.finished') text = value.response.text;
    }
    return text;
  } finally {
    try {
      await store.saveMessages(
        thread.id,
        eventJson(
          messages.list(),
          generation.redactions(),
        ) as unknown as readonly ProviderMessage[],
      );
    } catch {
      throw new ThreadPersistenceError();
    }
  }
};
