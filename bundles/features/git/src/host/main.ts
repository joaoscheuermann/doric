// `git`'s host part as a process (phase 3, S55): `git.commands/v1` and the
// `git` tool served through the router. Built into
// `dist/host/main.mjs`; the running host keeps the kernel entry
// (`./index.ts`) until S62.

import { ToolHandlerService } from 'bundle/contracts/gen/doric/tools/v1/tools_pb.js';
import { runBundle } from 'bundle/host';

import { CommandsService } from '../contracts/gen/doric/git/commands/v1/commands_pb.js';
import { createGitProcessHost } from './part.js';

const host = createGitProcessHost();

runBundle({
  services: [
    [CommandsService, host.commands],
    [ToolHandlerService, host.tools.implementation],
  ],
  activate: host.activate,
});
