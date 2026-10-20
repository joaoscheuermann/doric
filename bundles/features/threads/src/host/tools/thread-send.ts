import { defineTool } from 'tool';
import { z } from 'zod';

import { threadsOf } from '../threads.js';

export const tool = defineTool({
  name: 'thread-send',
  description:
    'Queue a follow-up task or instruction in a direct child chat without interrupting its current execution. Its result returns automatically. A child whose prompt failed is already healthy — this continues it; a child whose thread itself failed needs thread-restart.',
  input: z
    .object({
      threadId: z.uuid(),
      prompt: z
        .string()
        .min(1)
        .refine((value) => value.trim().length > 0),
    })
    .strict(),
  output: z.string(),
  execute: async (input, call, services) =>
    JSON.stringify(
      await threadsOf(services, call).send(input.threadId, input.prompt, call),
    ),
});
