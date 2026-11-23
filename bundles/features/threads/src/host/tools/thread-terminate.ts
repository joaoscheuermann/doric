import { defineTool } from 'tool';
import { z } from 'zod';

import type { ThreadToolPorts } from '../threads.js';

export const tool = defineTool({
  name: 'thread-terminate',
  description:
    'Close a direct child and its descendants, cancelling active and queued work. Keeps history and the shared project sandbox.',
  input: z.object({ threadId: z.uuid() }).strict(),
  output: z.string(),
  execute: async (input, call, ports: ThreadToolPorts) =>
    JSON.stringify(await ports.controls(call).terminate(input.threadId)),
});
