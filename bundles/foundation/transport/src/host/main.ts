// src/host/main.ts — `transport`'s host part as a process (phase 3, S60).
// The eight `doric.api.*` services and the `onHostStartHook` handler, built into `dist/host/main.mjs`.

import { HookHandlerService } from 'bundle/contracts/gen/doric/hooks/v1/hooks_pb.js';
import { runBundle } from 'bundle/host';

import { ConfigService } from '../contracts/gen/doric/api/config/v1/config_pb.js';
import { CredentialsService } from '../contracts/gen/doric/api/credentials/v1/credentials_pb.js';
import { HostService } from '../contracts/gen/doric/api/host/v1/host_pb.js';
import { ProjectsService } from '../contracts/gen/doric/api/projects/v1/projects_pb.js';
import { ProvidersService } from '../contracts/gen/doric/api/providers/v1/providers_pb.js';
import { StatusService } from '../contracts/gen/doric/api/status/v1/status_pb.js';
import { TerminalsService } from '../contracts/gen/doric/api/terminals/v1/terminals_pb.js';
import { ThreadsService } from '../contracts/gen/doric/api/threads/v1/threads_pb.js';
import { createTransportHost } from './process/service.js';

const host = createTransportHost();

runBundle({
  services: [
    [ConfigService, host.config],
    [CredentialsService, host.credentials],
    [ProvidersService, host.providers],
    [HostService, host.host],
    [ProjectsService, host.projects],
    [ThreadsService, host.threads],
    [TerminalsService, host.terminals],
    [StatusService, host.status],
    [HookHandlerService, host.hooks.implementation],
  ],
  invalidInput: host.invalidInput,
  activate: host.activate,
  deactivate: host.deactivate,
});
