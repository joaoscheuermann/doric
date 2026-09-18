import type { Sandbox } from 'sandbox';
import { defineTool } from 'tool';
import { z } from 'zod';

import type {
  InterruptResult,
  Page,
  PromptResult,
  Thread,
  ThreadEvent,
} from './workspace.js';

/** Capabilities bound to one active parent prompt, never to model-supplied identity. */
export interface ThreadCoordination {
  spawn(
    prompt: string,
  ): Promise<{ readonly threadId: string; readonly promptId: string }>;
  list(limit: number, cursor?: string): Promise<Page<Thread>>;
  get(
    threadId: string,
    afterSequence: number,
  ): Promise<{
    readonly thread: Thread;
    readonly events: readonly ThreadEvent[];
  }>;
  send(threadId: string, prompt: string): Promise<PromptResult>;
  interrupt(threadId: string, promptId: string): Promise<InterruptResult>;
  terminate(threadId: string): Promise<Thread>;
}

export const coordinationNames = [
  'spawn_thread',
  'list_threads',
  'get_thread',
  'send_to_thread',
  'interrupt_thread',
  'terminate_thread',
] as const;

/** Uses the existing tool contract without giving sandbox tools host privileges. */
export const createCoordinationTools = (
  control: ThreadCoordination,
  sandbox: Sandbox,
) => {
  const prompt = z
    .string()
    .min(1)
    .refine((value) => value.trim().length > 0);
  const threadId = z.uuid();
  const output = z.string();
  return [
    defineTool({
      name: 'spawn_thread',
      description:
        'Create a child chat and delegate a self-contained task. Returns immediately. The child shares this project workspace; its result arrives automatically in this chat.',
      input: z.object({ prompt }).strict(),
      output,
      execute: async (_sandbox, input) =>
        JSON.stringify(await control.spawn(input.prompt)),
    })(sandbox),
    defineTool({
      name: 'list_threads',
      description:
        'List your direct child chats and their states. Use the next cursor to continue.',
      input: z
        .object({
          limit: z.number().int().min(1).max(100).optional(),
          cursor: z.uuid().optional(),
        })
        .strict(),
      output,
      execute: async (_sandbox, input) =>
        JSON.stringify(await control.list(input.limit ?? 50, input.cursor)),
    })(sandbox),
    defineTool({
      name: 'get_thread',
      description:
        'Read a direct child chat state and its persisted events after an exclusive sequence cursor.',
      input: z
        .object({ threadId, afterSequence: z.number().int().min(0).optional() })
        .strict(),
      output,
      execute: async (_sandbox, input) =>
        JSON.stringify(
          await control.get(input.threadId, input.afterSequence ?? 0),
        ),
    })(sandbox),
    defineTool({
      name: 'send_to_thread',
      description:
        'Queue a follow-up task or instruction in a direct child chat without interrupting its current execution. Its result returns automatically.',
      input: z.object({ threadId, prompt }).strict(),
      output,
      execute: async (_sandbox, input) =>
        JSON.stringify(await control.send(input.threadId, input.prompt)),
    })(sandbox),
    defineTool({
      name: 'interrupt_thread',
      description:
        'Cancel only the identified active prompt of a direct child. Keeps its queued inputs, descendants and chat open. Does not undo effects.',
      input: z.object({ threadId, promptId: z.uuid() }).strict(),
      output,
      execute: async (_sandbox, input) =>
        await control.interrupt(input.threadId, input.promptId),
    })(sandbox),
    defineTool({
      name: 'terminate_thread',
      description:
        'Close a direct child and its descendants, cancelling active and queued work. Keeps history and the shared project sandbox.',
      input: z.object({ threadId }).strict(),
      output,
      execute: async (_sandbox, input) =>
        JSON.stringify(await control.terminate(input.threadId)),
    })(sandbox),
  ];
};
