import { z } from 'zod';

import { defineTool } from 'tool';

export default defineTool({
  name: 'terminate_thread',
  description:
    'Close a direct child and its descendants, cancelling active and queued work. Keeps history and the shared project sandbox.',
  input: z.object({ threadId: z.uuid() }).strict(),
  output: z.string(),
  execute: async (sandbox, host, input) =>
    JSON.stringify(await host.threads.terminate(input.threadId)),
});
