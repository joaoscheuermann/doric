// The `postgres` bundle's host part as a process (spec
// `docs/designs/grpc-processes.md`, section 17, "Storage until phase 4";
// phase 3, slice S38): `storage.backend/v1` and `secrets.backend/v1` over
// today's PostgreSQL rows, served through the router. Built into
// `dist/host/main.mjs`; the running host keeps the kernel entry
// (`./index.ts`) until the switch, slice S62.

import { BackendService as SecretsBackendService } from 'bundle/contracts/gen/doric/secrets/backend/v1/backend_pb.js';
import { BackendService as StorageBackendService } from 'bundle/contracts/gen/doric/storage/backend/v1/backend_pb.js';
import { type HostContext, runBundle } from 'bundle/host';
import { serveSecretsBackend, serveStorageBackend } from 'storage/rpc';

import { createPostgresBackends } from './backends.js';

/** The instance's context, set by `activate`; `Connect` logs through it. */
let context: HostContext | undefined;

/** Built at load with no I/O: the client is created on first use. */
const postgres = createPostgresBackends({
  log: { info: (message, fields) => context?.log.info(message, fields) },
});

runBundle({
  services: [
    [StorageBackendService, serveStorageBackend(postgres.storage)],
    [SecretsBackendService, serveSecretsBackend(postgres.secrets)],
  ],
  activate: (activated) => {
    context = activated;
  },
  deactivate: () => postgres.close(),
});
