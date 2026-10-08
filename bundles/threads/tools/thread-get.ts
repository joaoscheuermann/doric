import { defineTool } from 'tool';
import { z } from 'zod';

export default defineTool({
  name: 'thread-get',
  description:
    "Read a direct child chat's state and, when a prompt has finished, the result of its most recent finished prompt. It never carries the transcript; use thread-events only when intermediate progress is needed.",
  input: z.object({ threadId: z.uuid() }).strict(),
  output: z.string(),
  execute: async (_sandbox, host, input) =>
    JSON.stringify(await host.threads.get(input.threadId)),
});
