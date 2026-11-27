// `mcp`'s host part as a process (phase 3, S59).
import { HookHandlerService } from 'bundle/contracts/gen/doric/hooks/v1/hooks_pb.js';
import { ToolHandlerService } from 'bundle/contracts/gen/doric/tools/v1/tools_pb.js';
import { runBundle } from 'bundle/host';
import { SkillSourcesService } from 'default/contracts/gen/doric/default/skill_sources/v1/skill_sources_pb.js';

import { McpService } from '../contracts/gen/doric/mcp/v1/mcp_pb.js';
import { createMcpHost } from './service.js';

const host = createMcpHost();

runBundle({
  services: [
    [McpService, host.mcp],
    [SkillSourcesService, host.skillSources],
    [ToolHandlerService, host.tools.implementation],
    [HookHandlerService, host.hooks.implementation],
  ],
  activate: host.activate,
  deactivate: host.deactivate,
});
