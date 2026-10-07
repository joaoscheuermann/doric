import { defineTool } from 'tool';
import { z } from 'zod';

export default defineTool({
  name: 'thread-spawn',
  description:
    'Create a child chat and delegate a self-contained task. Returns immediately. The child shares this project workspace; its result arrives automatically in this chat.',
  input: z
    .object({
      prompt: z
        .string()
        .min(1)
        .refine((value) => value.trim().length > 0),
    })
    .strict(),
  output: z.string(),
  execute: async (_sandbox, host, input) =>
    JSON.stringify(await host.threads.spawn(input.prompt)),
});
