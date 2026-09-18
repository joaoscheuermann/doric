import { defineTool } from 'tool';
import { z } from 'zod';

import type { ThreadCoordination } from '../../../workspace/coordination.js';

export const name = 'terminate_thread';

export const create = (control: ThreadCoordination) =>
  defineTool({
    name,
    description:
      'Close a direct child and its descendants, cancelling active and queued work. Keeps history and the shared project sandbox.',
    input: z.object({ threadId: z.uuid() }).strict(),
    output: z.string(),
    execute: async (_sandbox, input) =>
      JSON.stringify(await control.terminate(input.threadId)),
  });
