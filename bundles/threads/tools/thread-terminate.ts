import { defineTool } from 'tool';
import { z } from 'zod';

export default defineTool({
  name: 'thread-terminate',
  description:
    'Close a direct child and its descendants, cancelling active and queued work. Keeps history and the shared project sandbox.',
  input: z.object({ threadId: z.uuid() }).strict(),
  output: z.string(),
  execute: async (sandbox, host, input) =>
    JSON.stringify(await host.threads.terminate(input.threadId)),
});
