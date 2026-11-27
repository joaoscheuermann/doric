// `terminal`'s host part as a process (phase 3, S54b): `terminal/v1`, the
// `terminal` tool and the `onThreadsClosingHook` handler served through the
// router. Built into `dist/host/main.mjs`.

import { HookHandlerService } from 'bundle/contracts/gen/doric/hooks/v1/hooks_pb.js';
import { ToolHandlerService } from 'bundle/contracts/gen/doric/tools/v1/tools_pb.js';
import { runBundle } from 'bundle/host';

import { TerminalService } from '../contracts/gen/doric/terminal/v1/terminal_pb.js';
import { createTerminalProcessHost } from './service.js';

const host = createTerminalProcessHost();

runBundle({
  services: [
    [TerminalService, host.terminal],
    [ToolHandlerService, host.tools.implementation],
    [HookHandlerService, host.hooks.implementation],
  ],
  activate: host.activate,
  deactivate: host.deactivate,
});
