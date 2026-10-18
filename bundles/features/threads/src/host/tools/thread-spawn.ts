import { defineTool } from 'tool';
import { z } from 'zod';

import { threadsOf } from '../threads.js';

export const tool = defineTool({
  name: 'thread-spawn',
  description:
    'Create a child chat and delegate a self-contained task. Returns immediately. The child shares this project workspace; its result arrives automatically in this chat. Give it a short title (up to 80 characters) naming the task, as the user sees it in the thread list; without one, the chat is named after the start of the prompt.',
  input: z
    .object({
      prompt: z
        .string()
        .min(1)
        .refine((value) => value.trim().length > 0),
      title: z
        .string()
        .refine((value) => value.trim().length > 0)
        .optional(),
    })
    .strict(),
  output: z.string(),
  execute: async (input, call, services) =>
    JSON.stringify(
      await threadsOf(services, call).spawn(input.prompt, input.title, call),
    ),
});
