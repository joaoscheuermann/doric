import { defineTool } from 'tool';
import { z } from 'zod';

import type { ThreadCoordination } from '../../../workspace/coordination.js';

export const name = 'list_threads';

export const create = (control: ThreadCoordination) =>
  defineTool({
    name,
    description:
      'List your direct child chats and their states. Use the next cursor to continue.',
    input: z
      .object({
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.uuid().optional(),
      })
      .strict(),
    output: z.string(),
    execute: async (_sandbox, input) =>
      JSON.stringify(await control.list(input.limit ?? 50, input.cursor)),
  });
