// `web`'s host part as a process (phase 3, S50): the web tool served as
// `ToolHandlerService` and registered through `tools/v1`. The running host
// keeps the kernel entry (`./index.ts`) until S62.
import { ToolHandlerService } from 'bundle/contracts/gen/doric/tools/v1/tools_pb.js';
import { createToolHandlers, runBundle } from 'bundle/host';

import { registerWebTool } from './part.js';

const tools = createToolHandlers();

runBundle({
  services: [[ToolHandlerService, tools.implementation]],
  activate: async (context) => {
    await registerWebTool(context, tools);
  },
});
