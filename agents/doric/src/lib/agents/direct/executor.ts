import { createAgent, createToolCallStorage } from 'agent';
import type { ExecutionRef, Skill } from 'bundle';
import type { Call } from 'bundle/contracts';
import type { ProviderMessage } from 'llms';
import { createMessageStorage } from 'messages';
import { type BoundTool, createToolStorage, ToolErrorObject } from 'tool';

import type { HostAdapter } from '../../bundles/adapter.js';
import type { BundleLease } from '../../bundles/boot.js';
import type { Generation } from '../../config/generation.js';
import { providerFor } from '../../config/generation.js';
import { resolveToolConfigs } from '../../config/tool-config.js';
import { eventJson } from '../../events/serialization.js';
import {
  type PromptJob,
  type ThreadExecution,
  ThreadPersistenceError,
} from '../../workspace/runtime.js';
import type {
  Thread,
  ThreadStore,
  WorkspacePublisher,
} from '../../workspace/types.js';
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

export type { BundleLease } from '../../bundles/boot.js';

export interface DirectExecutorOptions {
  /** Pins the run to the active bundle generation and reads its tools and skills. */
  readonly acquire: (
    execution: ExecutionRef,
    signal: AbortSignal,
  ) => Promise<BundleLease>;
  /** Binds the prompt's Host and sandbox for the bundle contracts its tools use. */
  readonly attach: HostAdapter['attach'];
}

/**
 * Runs one input, retaining provider-ready history independently for each
 * Thread. Every tool the bundles registered is bound to the prompt's `Call`,
 * whose scope names the prompt, and the prompt's Host facade and sandbox stay
 * attached to that scope until the run's final save.
 */
export const createDirectExecutor =
  (options: DirectExecutorOptions): ThreadExecution =>
  async ({
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
    const scope = {
      projectId: thread.projectId,
      threadId: thread.id,
      promptId: job.id,
    };
    const lease = await options.acquire(scope, signal);
    try {
      const release = options.attach(scope, { host, sandbox });
      try {
        const call = lease.call(scope, signal);
        return await run({
          record,
          job,
          generation,
          signal,
          store,
          publisher,
          thread,
          call,
          tools: lease.tools(call),
          skills: await lease.skills(call),
        });
      } finally {
        release();
      }
    } finally {
      lease.release();
    }
  };

const run = async ({
  record,
  job,
  generation,
  signal,
  store,
  publisher,
  thread,
  call,
  tools,
  skills,
}: {
  readonly record: NonNullable<Awaited<ReturnType<ThreadStore['find']>>>;
  readonly job: PromptJob;
  readonly generation: Generation;
  readonly signal: AbortSignal;
  readonly store: ThreadStore;
  readonly publisher: WorkspacePublisher;
  readonly thread: Thread;
  readonly call: Call;
  readonly tools: readonly BoundTool[];
  readonly skills: readonly Skill[];
}): Promise<string> => {
  const boundary = record.checkpoints[job.id];
  const resume = boundary !== undefined && record.messages.length > boundary;
  const messages = createMessageStorage(repaired(record.messages));
  let pendingEvent: unknown;
  const retry = async () => {
    await save();
    if (pendingEvent !== undefined) {
      const stored = await store.appendEvent(thread.id, job.id, pendingEvent);
      pendingEvent = undefined;
      publisher.event(stored);
    }
  };
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
      throw new ThreadPersistenceError(cause, retry);
    }
  };
  const execution = generation.snapshot.configuration.models.execution;
  const agent = createAgent({
    provider: providerFor(generation, execution.providerId),
    model: execution.model,
    effort: execution.effort,
    system: directSystemPrompt(skills),
    tools: createToolStorage(
      (() => {
        // Tool values reach tools through settings/v1 from stage 2; resolving
        // them here still refuses a prompt whose tool settings are unmet.
        resolveToolConfigs(tools, generation.snapshot.configuration);

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
      maxTurns: generation.snapshot.configuration.execution.maxTurns,
      maxToolResultChars:
        generation.snapshot.configuration.execution.maxToolResultChars,
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
        await save();
        throw signal.reason;
      }
      try {
        pendingEvent = eventJson(
          value.type === 'response.started'
            ? { ...value, providerId: execution.providerId }
            : value,
          generation.redactions(),
        );
        if (addedMessages(value)) await save();
        const stored = await store.appendEvent(thread.id, job.id, pendingEvent);
        pendingEvent = undefined;
        publisher.event(stored);
      } catch (cause) {
        throw new ThreadPersistenceError(cause, retry);
      }
      signal.throwIfAborted();
      if (value.type === 'agent.finished') text = value.response.text;
    }
    return text;
  } finally {
    // The run ended, so whatever it left — complete or partial — is the history
    // its Thread carries on with.
    if (!lost) await save();
  }
};
