import { defineTool } from 'tool';
import { z } from 'zod';

import type { ThreadToolPorts } from '../threads.js';

export const tool = defineTool({
  name: 'thread-list',
  description:
    'List your direct child chats and their states. Use the next cursor to continue.',
  input: z
    .object({
      limit: z.number().int().min(1).max(100).optional(),
      cursor: z.uuid().optional(),
    })
    .strict(),
  output: z.string(),
  execute: async (input, call, ports: ThreadToolPorts) =>
    JSON.stringify(
      await ports.controls(call).list(input.limit ?? 50, input.cursor),
    ),
});
