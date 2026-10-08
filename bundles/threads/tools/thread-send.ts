import { defineTool } from 'tool';
import { z } from 'zod';

export default defineTool({
  name: 'thread-send',
  description:
    'Queue a follow-up task or instruction in a direct child chat without interrupting its current execution. Its result returns automatically.',
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
  execute: async (_sandbox, host, input) =>
    JSON.stringify(await host.threads.send(input.threadId, input.prompt)),
});
