import { defineTool } from 'tool';
import { z } from 'zod';

import { threadsOf } from '../threads.js';

export const tool = defineTool({
  name: 'thread-interrupt',
  description:
    'Cancel only the identified active prompt of a direct child. Keeps its queued inputs, descendants and chat open. Does not undo effects.',
  input: z.object({ threadId: z.uuid(), promptId: z.uuid() }).strict(),
  output: z.string(),
  execute: async (input, call, services) =>
    await threadsOf(services, call).interrupt(
      input.threadId,
      input.promptId,
      call,
    ),
});
