// The `firecracker` bundle's host part as a process (spec
// `docs/designs/grpc-processes.md`, "Sandbox leases"; phase 3, slice S44):
// `sandbox/v1` by lease id through the router. Built into
// `dist/host/main.mjs`; the running host keeps the kernel entry
// (`./index.ts`) until the switch, slice S62.

import { ContractError } from 'bundle/contracts';
import { HookHandlerService } from 'bundle/contracts/gen/doric/hooks/v1/hooks_pb.js';
import { createHookHandlers, runBundle } from 'bundle/host';
import { SandboxService } from 'runtime/contracts/gen/doric/sandbox/v1/sandbox_pb.js';

import { firecrackerSandboxBinding } from './sandbox.js';
import { createSandboxService, type SandboxPoolBinding } from './service.js';
import { registerSandboxPoolStep } from './start.js';

/** The pool `activate` set up; unset before it. */
let binding: SandboxPoolBinding | undefined;

const sandbox = createSandboxService(() => {
  if (binding === undefined) {
    throw new ContractError('unavailable', 'The sandbox pool is not ready.');
  }

  return binding;
});

const hooks = createHookHandlers();

runBundle({
  services: [
    [SandboxService, sandbox.implementation],
    [HookHandlerService, hooks.implementation],
  ],
  activate: async (context) => {
    binding = firecrackerSandboxBinding({}, context.log);
    context.instances.onGone((instance) => sandbox.dropInstance(instance));
    await registerSandboxPoolStep(hooks, context, process.env);
  },
  deactivate: async () => {
    await sandbox.releaseAll();
    await binding?.pool.dispose();
  },
});
