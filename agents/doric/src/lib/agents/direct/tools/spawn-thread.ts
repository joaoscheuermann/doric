import { defineTool } from 'tool';
import { z } from 'zod';

import type { ThreadCoordination } from '../../../workspace/coordination.js';

export const name = 'spawn_thread';

export const create = (control: ThreadCoordination) =>
  defineTool({
    name,
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
    execute: async (_sandbox, input) =>
      JSON.stringify(await control.spawn(input.prompt)),
  });
