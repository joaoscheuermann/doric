import { z } from 'zod';

import { defineTool } from 'tool';

export default defineTool({
  name: 'get_thread',
  description:
    'Read a direct child chat state and its persisted events after an exclusive sequence cursor.',
  input: z
    .object({
      threadId: z.uuid(),
      afterSequence: z.number().int().min(0).optional(),
    })
    .strict(),
  output: z.string(),
  execute: async (sandbox, host, input) =>
    JSON.stringify(
      await host.threads.get(input.threadId, input.afterSequence ?? 0),
    ),
});
