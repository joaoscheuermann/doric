// `core`'s host part as a process (spec `docs/designs/grpc-processes.md`,
// "Files, phase 3"; slice S41): its data and registration services and
// `models/v1`, served through the router. Built into `dist/host/main.mjs`;
// the running host keeps the kernel entry (`./index.ts`) until the switch,
// slice S62.

import { createRegistry, type Registry } from '@bufbuild/protobuf';
import { EventsService } from 'bundle/contracts/gen/doric/events/v1/events_pb.js';
import { HooksService } from 'bundle/contracts/gen/doric/hooks/v1/hooks_pb.js';
import { LogService } from 'bundle/contracts/gen/doric/log/v1/log_pb.js';
import { ModelsService } from 'bundle/contracts/gen/doric/models/v1/models_pb.js';
import { SecretsService } from 'bundle/contracts/gen/doric/secrets/v1/secrets_pb.js';
import { SettingsService } from 'bundle/contracts/gen/doric/settings/v1/settings_pb.js';
import { SkillsService } from 'bundle/contracts/gen/doric/skills/v1/skills_pb.js';
import { StorageService } from 'bundle/contracts/gen/doric/storage/v1/storage_pb.js';
import { ToolsService } from 'bundle/contracts/gen/doric/tools/v1/tools_pb.js';
import { ajvValidators, runBundle } from 'bundle/host';

import { createCoreServices } from './services.js';
import { loadCatalogTypes } from './types.js';

/** Every bundle's message types, read from the catalog in `activate`. */
let types: Registry = createRegistry();

/** Built at load with no I/O; bound to the instance in `activate`. */
const core = createCoreServices({
  types: () => types,
  validators: ajvValidators(),
});

runBundle({
  services: [
    [StorageService, core.implementations.storage],
    [SettingsService, core.implementations.settings],
    [SecretsService, core.implementations.secrets],
    [EventsService, core.implementations.events],
    [ToolsService, core.implementations.tools],
    [SkillsService, core.implementations.skills],
    [HooksService, core.implementations.hooks],
    [LogService, core.implementations.log],
    [ModelsService, core.implementations.models],
  ],
  activate: async (context) => {
    types = await loadCatalogTypes(context.services, {
      signal: context.signal,
    });
    core.activate(context);
  },
});
