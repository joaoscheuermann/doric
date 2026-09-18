import { defineTool } from 'tool';
import { z } from 'zod';

import type { ThreadCoordination } from '../../../workspace/coordination.js';

export const name = 'interrupt_thread';

export const create = (control: ThreadCoordination) =>
  defineTool({
    name,
    description:
      'Cancel only the identified active prompt of a direct child. Keeps its queued inputs, descendants and chat open. Does not undo effects.',
    input: z.object({ threadId: z.uuid(), promptId: z.uuid() }).strict(),
    output: z.string(),
    execute: async (_sandbox, input) =>
      await control.interrupt(input.threadId, input.promptId),
  });
