// The layout's view of chat's `chat.hooks/v1` (D9-10). Hooks are matched by
// contract ID only, so the layout keeps a structural copy of the one hook it
// registers instead of importing `chat/contracts`, which a composition
// without chat would not map.

import { defineHook, defineHooks } from 'bundle/contracts';
import { z } from 'zod';

export const ChatHooksV1 = defineHooks('chat.hooks/v1', {
  onSandboxActivityHook: defineHook({
    kind: 'observe',
    input: z.object({ projectId: z.string() }).strict(),
  }),
});
