import { z } from 'zod';

import { defineTool } from 'tool';

export default defineTool({
  name: 'interrupt_thread',
  description:
    'Cancel only the identified active prompt of a direct child. Keeps its queued inputs, descendants and chat open. Does not undo effects.',
  input: z.object({ threadId: z.uuid(), promptId: z.uuid() }).strict(),
  output: z.string(),
  execute: async (sandbox, host, input) =>
    await host.threads.interrupt(input.threadId, input.promptId),
});
