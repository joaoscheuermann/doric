import { defineTool } from 'tool';
import { z } from 'zod';

import { threadsOf } from '../threads.js';

export const tool = defineTool({
  name: 'thread-restart',
  description:
    'Reopen a direct child chat whose thread itself failed and queue a prompt in it: the one you give, or the last prompt the child accepted. Same chat, same history, same parent. A child whose prompt failed but whose thread is healthy is already continuable — use thread-send for that. A cancelled child cannot be reopened, and only a live parent can restart its child.',
  input: z
    .object({
      threadId: z.uuid(),
      prompt: z
        .string()
        .min(1)
        .refine((value) => value.trim().length > 0)
        .optional(),
    })
    .strict(),
  output: z.string(),
  execute: async (input, call, services) =>
    JSON.stringify(
      await threadsOf(services, call).restart(
        input.threadId,
        input.prompt,
        call,
      ),
    ),
});
