// The provisional features' activation (stage 9 §5.10): their host adapter
// and the window's terminal streams, bound to the layout's activation
// services (D9-17). The layout's `activate` calls `initProvisional` and its
// cleanup calls `disposeProvisional`. Stage 10 moves these features to their
// owner bundles and deletes this folder.

import { DoricConnectionV1, type Services } from 'bundle/contracts';

import { RuntimeTerminalsV1 } from './api/host.js';
import {
  api,
  disposeProvisionalApi,
  initProvisionalApi,
  setTerminalWatches,
} from './api/provisional-api.js';
import {
  createTerminalWatches,
  type TerminalWatches,
} from './terminals/api/terminal-watch.js';

let watches: TerminalWatches | undefined;

export const initProvisional = (services: Services): void => {
  disposeProvisional();
  initProvisionalApi(services);
  const created = createTerminalWatches({
    terminals: services.use(RuntimeTerminalsV1),
    snapshot: (id) => api.terminals.snapshot(id),
    connection: services.use(DoricConnectionV1),
  });
  watches = created;
  setTerminalWatches(() => created);
};

export const disposeProvisional = (): void => {
  watches?.close();
  watches = undefined;
  setTerminalWatches(undefined);
  disposeProvisionalApi();
};

export {
  cwdHosts,
  newTerminalHosts,
  ProvisionalPortals,
  usageHosts,
} from './portals.js';
