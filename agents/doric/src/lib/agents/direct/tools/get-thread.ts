import { defineTool } from 'tool';
import { z } from 'zod';

import type { ThreadCoordination } from '../../../workspace/coordination.js';

export const name = 'get_thread';

export const create = (control: ThreadCoordination) =>
  defineTool({
    name,
    description:
      'Read a direct child chat state and its persisted events after an exclusive sequence cursor.',
    input: z
      .object({
        threadId: z.uuid(),
        afterSequence: z.number().int().min(0).optional(),
      })
      .strict(),
    output: z.string(),
    execute: async (_sandbox, input) =>
      JSON.stringify(
        await control.get(input.threadId, input.afterSequence ?? 0),
      ),
  });
