import type { Services } from 'bundle/contracts';
import { useMemo } from 'react';

import { ResourcesV1 } from '../../contracts/index.js';
import { LayoutWorkspaceV1 } from '../api/peers.js';
import { createResourcesReads } from '../api/resources.js';
import { useService, useSubscribed } from '../hooks/use-service.js';
import { ResourceMonitor } from './resource-monitor.js';

/**
 * `<resources-monitor>`: the monitor for the Project the workspace shows,
 * as the layout's footer drew it with `selectedProject?.id`. Without the
 * layout there is no selection, so only the machine control has a reading.
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
  return <ResourceMonitor reads={reads} projectId={projectId} />;
}
