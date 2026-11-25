import type { Services } from 'bundle/contracts';
import { useMemo } from 'react';
import { RuntimeRecordsV1 } from 'runtime/contracts';

import { WorkspaceSelectionV1 } from '../api/peers.js';
import { createResourcesReads, resourcesHostOf } from '../api/resources.js';
import { useService, useSubscribed } from '../hooks/use-service.js';
import { ConnectionBadge } from './connection-badge.js';

/**
 * `<resources-monitor>`: the connection badge for the Project the workspace
 * shows. It reads the selection from `workspace.selection/v1` (`current()`)
 * and the connection from `runtime.records/v1` (`connection()`) through
 * `useSubscribed`, so each follows its contract's `subscribe`.
 *
 * Without a `runtime.records/v1` provider the badge shows Disconnected; without
 * a `workspace.selection/v1` provider it polls the machine only (G10).
 */
export function ResourcesMonitorView({
  services,
}: {
  readonly services: Services;
}) {
  const selection = useService(services, WorkspaceSelectionV1);
  const projectId = useSubscribed(
    selection,
    () => selection?.current().projectId,
    undefined,
  );
  const records = useService(services, RuntimeRecordsV1);
  const connected = useSubscribed(
    records,
    () => records?.connection() === 'connected',
    false,
  );
  const reads = useMemo(
    () => createResourcesReads(resourcesHostOf(services)),
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
