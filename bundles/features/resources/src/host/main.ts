// `resources`' host part as a process (phase 3, slice S50b): `resources/v1`
// served through the router, reading the calling Project's container over
// `runtime.lease/v1`. The running host keeps the kernel entry (`./index.ts`)
// until S62.
import { runBundle } from 'bundle/host';

import { ResourcesService } from '../contracts/gen/doric/resources/v1/resources_pb.js';
import { createResourcesService } from './rpc/resources.js';

const resources = createResourcesService();

runBundle({
  services: [[ResourcesService, resources.implementation]],
  activate: (context) => resources.activate(context),
});
