// The optional chat peer of the files client, as a structural copy of its
// contract: hooks are matched by contract ID only, and a composition without
// chat would not map its contracts module. It is used through `whenAvailable`,
// so it is not in the manifest's `requires`.

import { defineHook, defineHooks } from 'bundle/contracts';
import type { ThreadUpdateNotice } from 'chat/contracts';
import { z } from 'zod';

/**
 * chat.hooks/v2 (D12): the Project of a Thread the chat starts to hold, moves
 * or finishes (`onSandboxActivityHook`), and every live event of a held Thread
 * (`onThreadUpdateHook`), from which `files` takes its own tools' calls.
 */
export const ChatHooksV2 = defineHooks('chat.hooks/v2', {
  onSandboxActivityHook: defineHook({
    kind: 'observe',
    input: z.object({ projectId: z.string() }).strict(),
  }),
  onThreadUpdateHook: defineHook({
    kind: 'observe',
    input: z.object({
      projectId: z.string(),
      threadId: z.string(),
      threadName: z.string(),
      update: z.custom<ThreadUpdateNotice>(
        (value) =>
          typeof value === 'object' &&
          value !== null &&
          'kind' in value &&
          (value.kind === 'event' || value.kind === 'updated'),
      ),
    }),
  }),
});

export type ThreadUpdateInput = z.output<
  (typeof ChatHooksV2)['hooks']['onThreadUpdateHook']['input']
>;
