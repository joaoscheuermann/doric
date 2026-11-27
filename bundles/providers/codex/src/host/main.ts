// `codex`'s host part as a process (spec `docs/designs/grpc-processes.md`,
// "Model providers"; phase 3, slice S43): `models.provider/v1` through the
// router. Built into `dist/host/main.mjs`.

import { ContractError } from 'bundle/contracts';
import { ProviderService } from 'bundle/contracts/gen/doric/models/provider/v1/provider_pb.js';
import { type HostContext, runBundle } from 'bundle/host';
import { serveProviderKind } from 'llms/rpc';
import type { Logger } from 'pino';
import { AttachmentsService } from 'runtime/contracts/gen/doric/runtime/attachments/v1/attachments_pb.js';

import { codexKind } from './kind.js';
import { logV1Logger } from './logger.js';
import { kindSource } from './provider.js';

let context: HostContext | undefined;
let logger: Logger | undefined;

/** The instance's context; the router serves no call before `activate`. */
const contextOf = (): HostContext => {
  if (context === undefined) {
    throw new ContractError(
      'unavailable',
      'The codex bundle is not active yet.',
    );
  }

  return context;
};

/** Built at load with no I/O; the logger and attachments use the instance's context. */
const provider = serveProviderKind(
  kindSource(codexKind, {
    logger: () => (logger ??= logV1Logger(contextOf().log)),
  }),
  {
    readAttachment: (id, signal) =>
      contextOf().services.use(AttachmentsService).read({ id }, { signal }),
  },
);

runBundle({
  services: [[ProviderService, provider]],
  activate: (activated) => {
    context = activated;
  },
});
