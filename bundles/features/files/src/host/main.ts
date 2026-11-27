// `files`' host part as a process (phase 3, S53): `files/v1` and the seven
// workspace tools served through the router.

import { ToolHandlerService } from 'bundle/contracts/gen/doric/tools/v1/tools_pb.js';
import { runBundle } from 'bundle/host';

import { FilesService } from '../contracts/gen/doric/files/v1/files_pb.js';
import { createFilesHost } from './service.js';

const host = createFilesHost();

runBundle({
  services: [
    [FilesService, host.files],
    [ToolHandlerService, host.tools.implementation],
  ],
  activate: host.activate,
});
