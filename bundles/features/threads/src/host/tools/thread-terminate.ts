import { defineTool } from 'tool';
import { z } from 'zod';

import { threadsOf } from '../threads.js';

export const tool = defineTool({
  name: 'thread-terminate',
  description:
    'Close a direct child and its descendants, cancelling active and queued work. Keeps history and the shared project sandbox.',
  input: z.object({ threadId: z.uuid() }).strict(),
  output: z.string(),
  execute: async (input, call, services) =>
    JSON.stringify(
      await threadsOf(services, call).terminate(input.threadId, call),
    ),
});
