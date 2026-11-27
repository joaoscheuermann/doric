// `openui`'s host part as a process (phase 3, S56): `openui.programs/v1`,
// `openui.questions/v1` and the `onPromptStartedHook` handler served through
// the router. Built into `dist/host/main.mjs`.

import { HookHandlerService } from 'bundle/contracts/gen/doric/hooks/v1/hooks_pb.js';
import { runBundle } from 'bundle/host';

import { ProgramsService } from '../contracts/gen/doric/openui/programs/v1/programs_pb.js';
import { QuestionsService } from '../contracts/gen/doric/openui/questions/v1/questions_pb.js';
import { createOpenuiHost } from './service.js';

const host = createOpenuiHost();

runBundle({
  services: [
    [ProgramsService, host.programs],
    [QuestionsService, host.questions],
    [HookHandlerService, host.hooks.implementation],
  ],
  activate: host.activate,
  deactivate: host.deactivate,
});
