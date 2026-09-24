import { z } from 'zod';

import { defineTool } from 'tool';

export default defineTool({
  name: 'list_threads',
  description:
    'List your direct child chats and their states. Use the next cursor to continue.',
  input: z
    .object({
      limit: z.number().int().min(1).max(100).optional(),
      cursor: z.uuid().optional(),
    })
    .strict(),
  output: z.string(),
  execute: async (sandbox, host, input) =>
    JSON.stringify(await host.threads.list(input.limit ?? 50, input.cursor)),
});
