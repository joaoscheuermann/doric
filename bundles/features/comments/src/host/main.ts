// `comments`' host part as a process (phase 3, S52a): `comments/v1` and the
// `comment_reply` tool served through the router. Built into
// `dist/host/main.mjs`; the running host keeps the kernel entry
// (`./index.ts`) until S62.

import { ToolHandlerService } from 'bundle/contracts/gen/doric/tools/v1/tools_pb.js';
import { runBundle } from 'bundle/host';

import { CommentsService } from '../contracts/gen/doric/comments/v1/comments_pb.js';
import { createCommentsHost } from './service.js';

const host = createCommentsHost();

runBundle({
  services: [
    [CommentsService, host.comments],
    [ToolHandlerService, host.tools.implementation],
  ],
  activate: host.activate,
});
