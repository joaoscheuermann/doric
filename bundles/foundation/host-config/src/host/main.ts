// `host-config`'s host part as a process (spec `docs/designs/grpc-processes.md`,
// "Files, phase 3"; slice S45): `host-config/v1`, the configuration space's
// reference source and the configuration start step, through the router.
// Built into `dist/host/main.mjs`; the running host keeps the kernel entry
// (`./index.ts`) until the switch, slice S62.

import { HookHandlerService } from 'bundle/contracts/gen/doric/hooks/v1/hooks_pb.js';
import { ReferenceSourceService } from 'bundle/contracts/gen/doric/secrets/v1/secrets_pb.js';
import { createHookHandlers, runBundle } from 'bundle/host';

import { HostConfigService } from '../contracts/gen/doric/host_config/v1/host_config_pb.js';
import { createHostConfigServices } from './service.js';

const hooks = createHookHandlers();
const config = createHostConfigServices();

runBundle({
  services: [
    [HostConfigService, config.implementations.hostConfig],
    [ReferenceSourceService, config.implementations.references],
    [HookHandlerService, hooks.implementation],
  ],
  activate: (context) => config.activate(context, hooks),
});
