import { type AgentEvent, createAgent, createToolCallStorage } from 'agent';
import type { Skill } from 'bundle';
import { createMessageStorage } from 'messages';
import type { Sandbox } from 'sandbox';
import { createToolStorage } from 'tool';

import { eventJson } from './event-json.js';
import { type Generation, providerFor } from './generation.js';
import type { SessionStore } from './sessions.js';

type DirectPromptOptions = {
  readonly sessionId: string;
  readonly promptId: string;
  readonly prompt: string;
  readonly generation: Generation;
  readonly sandbox: Sandbox;
  readonly signal: AbortSignal;
  readonly store: SessionStore;
  readonly event: (
    value: Awaited<ReturnType<SessionStore['appendEvent']>>,
  ) => void;
};

/** Creates the deterministic Direct instruction followed by every bundle skill. */
export const directSystemPrompt = (skills: readonly Skill[]): string =>
  [
    '# Outcome',
    '',
    "Complete the user's request in the sandbox.",
    '',
    '# Instructions',
    '',
    '- Continue the conversation using its persisted history and the current sandbox state.',
    '- Use tools when evidence or sandbox changes are needed.',
    '- Give a concise final response that states the outcome and relevant verification.',
    ...skills.flatMap(({ name, body }) => ['', `## Skill: ${name}`, '', body]),
  ].join('\n');

/** Runs one prompt with fresh agent/tool-call state and persisted conversation history. */
export const runDirectPrompt = async ({
  sessionId,
  promptId,
  prompt,
  generation,
  sandbox,
  signal,
  store,
  event,
}: DirectPromptOptions): Promise<void> => {
  const record = await store.find(sessionId);

  if (record === undefined) {
    return;
  }

  const messages = createMessageStorage(record.messages);
  const execution = generation.snapshot.configuration.models.execution;

  const agent = createAgent({
    provider: providerFor(generation, execution.providerId),
    model: execution.model,
    effort: execution.effort,
    system: directSystemPrompt(generation.catalog.skills),
    tools: createToolStorage(
      generation.catalog.tools.map((factory) => factory(sandbox)),
    ),
    toolCalls: createToolCallStorage(),
    messages,
  });

  try {
    for await (const value of agent.stream(prompt, {
      signal,
      maxTurns: generation.snapshot.configuration.execution.maxTurns,
    })) {
      await publish({
        sessionId,
        promptId,
        value,
        generation,
        store,
        event,
      });
    }
  } finally {
    await store.finishPrompt(sessionId, messages.list());
  }
};

type PublishOptions = {
  readonly sessionId: string;
  readonly promptId: string;
  readonly value:
    | AgentEvent
    | { readonly type: string; readonly error: unknown };
  readonly generation: Generation;
  readonly store: SessionStore;
  readonly event: DirectPromptOptions['event'];
};

const publish = async ({
  sessionId,
  promptId,
  value,
  generation,
  store,
  event,
}: PublishOptions): Promise<void> => {
  const stored = await store.appendEvent(
    sessionId,
    promptId,
    eventJson(value, generation.redactions()),
  );

  event(stored);
};
