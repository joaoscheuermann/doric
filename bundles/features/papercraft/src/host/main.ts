// `papercraft`'s host part as a process (phase 3, S57).
import { HookHandlerService } from 'bundle/contracts/gen/doric/hooks/v1/hooks_pb.js';
import { runBundle } from 'bundle/host';

import { ProgramsService } from '../contracts/gen/doric/papercraft/programs/v1/programs_pb.js';
import { createPapercraftHost } from './service.js';

const host = createPapercraftHost();

runBundle({
  services: [
    [ProgramsService, host.programs],
    [HookHandlerService, host.hooks.implementation],
  ],
  activate: host.activate,
  deactivate: host.deactivate,
});
