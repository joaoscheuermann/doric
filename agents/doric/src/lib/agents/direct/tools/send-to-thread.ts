import { defineTool } from 'tool';
import { z } from 'zod';

import type { ThreadCoordination } from '../../../workspace/coordination.js';

export const name = 'send_to_thread';

export const create = (control: ThreadCoordination) =>
  defineTool({
    name,
    description:
      'Queue a follow-up task or instruction in a direct child chat without interrupting its current execution. Its result returns automatically.',
    input: z
      .object({
        threadId: z.uuid(),
        prompt: z
          .string()
          .min(1)
          .refine((value) => value.trim().length > 0),
      })
      .strict(),
    output: z.string(),
    execute: async (_sandbox, input) =>
      JSON.stringify(await control.send(input.threadId, input.prompt)),
  });
