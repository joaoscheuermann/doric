// `runtime`'s host part as a process (spec `docs/designs/grpc-processes.md`,
// "Files, phase 3"; slices S46–S48): every runtime service through the
// router. Built into `dist/host/main.mjs`; the running host keeps the kernel
// entry (`./index.ts`) until the switch, slice S62.

import { HookHandlerService } from 'bundle/contracts/gen/doric/hooks/v1/hooks_pb.js';
import { createHookHandlers, runBundle } from 'bundle/host';

import { SessionService } from '../contracts/gen/doric/executor/session/v1/session_pb.js';
import { AttachmentsService } from '../contracts/gen/doric/runtime/attachments/v1/attachments_pb.js';
import { LeaseService } from '../contracts/gen/doric/runtime/lease/v1/lease_pb.js';
import { ThreadsService } from '../contracts/gen/doric/runtime/threads/v1/threads_pb.js';
import { UsageService } from '../contracts/gen/doric/runtime/usage/v1/usage_pb.js';
import { RuntimeService } from '../contracts/gen/doric/runtime/v2/runtime_pb.js';
import { WorkspaceService } from '../contracts/gen/doric/runtime/workspace/v1/workspace_pb.js';
import { createRuntimeServices } from './service.js';

const hooks = createHookHandlers();
const runtime = createRuntimeServices({});

runBundle({
  services: [
    [RuntimeService, runtime.implementations.runtime],
    [ThreadsService, runtime.implementations.threads],
    [AttachmentsService, runtime.implementations.attachments],
    [UsageService, runtime.implementations.usage],
    [LeaseService, runtime.implementations.lease],
    [WorkspaceService, runtime.implementations.workspace],
    [SessionService, runtime.implementations.session],
    [HookHandlerService, hooks.implementation],
  ],
  activate: (context) => runtime.activate(context, hooks),
  deactivate: () => runtime.deactivate(),
});
