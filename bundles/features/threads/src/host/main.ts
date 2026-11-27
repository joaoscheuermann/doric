// `threads`' host part as a process (phase 3, S52b): the delegation tools
// served as `ToolHandlerService` and registered through `tools/v1`.
import { ToolHandlerService } from 'bundle/contracts/gen/doric/tools/v1/tools_pb.js';
import { createToolHandlers, runBundle } from 'bundle/host';

import { registerThreadTools } from './part.js';

const tools = createToolHandlers();

runBundle({
  services: [[ToolHandlerService, tools.implementation]],
  activate: async (context) => {
    await registerThreadTools(context, tools);
  },
});
