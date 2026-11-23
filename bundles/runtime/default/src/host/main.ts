// `default`'s host part as a process (phase 3, slice S51): `executor/v1` and
// `default.agents/v1` through the router; defines `default.hooks/v1`. Built
// into `dist/host/main.mjs`; the running host keeps the kernel entry
// (`./index.ts`) until S62.

import { runBundle } from 'bundle/host';
import { ExecutorService } from 'runtime/contracts/gen/doric/executor/v1/executor_pb.js';

import { AgentsService } from '../contracts/gen/doric/default/agents/v1/agents_pb.js';
import { createDefaultHost } from './service.js';

const host = createDefaultHost();

runBundle({
  services: [
    [ExecutorService, host.implementations.executor],
    [AgentsService, host.implementations.agents],
  ],
  activate: host.activate,
});
