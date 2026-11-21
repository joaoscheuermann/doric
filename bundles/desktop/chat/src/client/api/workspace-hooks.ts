import { defineHook, defineHooks } from 'bundle/contracts';
import { z } from 'zod';

/**
 * A structural copy of the one `workspace` hook this bundle observes. Hooks
 * are matched by contract ID only, so this avoids importing
 * `workspace/contracts`, which a composition without `workspace` would not
 * map (bundle isolation 4(c), decision O2).
 */
export const WorkspaceHooksV1 = defineHooks('workspace.hooks/v1', {
  /** The reader asked to open a Thread beside the conversation. */
  onOpenThreadHook: defineHook({
    kind: 'observe',
    input: z.object({ projectId: z.string(), threadId: z.string() }).strict(),
  }),
});
