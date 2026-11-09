import type { Services } from 'bundle/contracts';
import { useMemo } from 'react';

import { ResourcesV1 } from '../../contracts/index.js';
import { LayoutWorkspaceV1 } from '../api/peers.js';
import { createResourcesReads } from '../api/resources.js';
import { useService, useSubscribed } from '../hooks/use-service.js';
import { ConnectionBadge } from './connection-badge.js';

/**
 * `<resources-monitor>`: the connection badge for the Project the workspace
 * shows. It reads `layout.workspace/v1` for the selection (`selection()`) and
 * the connection (`connected()`) through `useSubscribed`, so both follow
 * `subscribe`.
 *
 * Without a `layout.workspace/v1` provider, `useService` answers `undefined`.
 * The badge then shows Disconnected and polls the machine only (G10).
 */
export function ResourcesMonitorView({
  services,
}: {
  readonly services: Services;
}) {
  const workspace = useService(services, LayoutWorkspaceV1);
  const projectId = useSubscribed(
    workspace,
    () => workspace?.selection().project?.id,
    undefined,
  );
  const connected = useSubscribed(
    workspace,
    () => workspace?.connected() ?? false,
    false,
  );
  const reads = useMemo(
    () =>
      createResourcesReads((id) =>
        services.use(
          ResourcesV1,
          id === undefined ? undefined : { projectId: id },
        ),
      ),
    [services],
  );
  return (
    <ConnectionBadge
      reads={reads}
      projectId={projectId}
      connected={connected}
    />
  );
}
