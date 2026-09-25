import { z } from 'zod';

import { defineTool } from 'tool';

export default defineTool({
  name: 'spawn_thread',
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
  execute: async (sandbox, host, input) =>
    JSON.stringify(await host.threads.spawn(input.prompt)),
});
