import { useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect } from 'react';

import type { ResourcesReads } from '../../src/client/api/resources.js';
import type {
  HostResources,
  ProjectResourcesResult,
} from '../../src/client/domain/resources.js';
import { resourcesKeys } from '../../src/client/hooks/use-resources.js';
import { ResourceMonitor } from '../../src/client/monitor/resource-monitor.js';
import { OpenOnMount, WithQueryClient } from '../support/query.js';
import {
  containerReading,
  fixtureReads,
  hostReading,
  idleContainer,
  projectId,
  readyProject,
  saturatedContainer,
} from '../support/resources.js';

const sandboxTrigger = 'button[aria-label^="Sandbox resources"]';
const machineTrigger = 'button[aria-label^="Machine resources"]';

/**
 * The monitor over fixture reads, with the readings already in the cache
 * (as after the first poll) unless `seeded` is false.
 */
function Monitor({
  host = hostReading,
  project = () => readyProject(),
  selectedProjectId = projectId,
  seeded = true,
  open,
  reads,
  children,
}: {
  readonly host?: () => HostResources;
  readonly project?: () => ProjectResourcesResult;
  readonly selectedProjectId?: string;
  readonly seeded?: boolean;
  readonly open?: string;
  readonly reads?: ResourcesReads;
  readonly children?: ReactNode;
}) {
  const monitor = (
    <ResourceMonitor
      reads={reads ?? fixtureReads({ host, project })}
      projectId={selectedProjectId}
    />
  );
  return (
    <WithQueryClient
      seed={(client) => {
        if (!seeded) return;
        client.setQueryData(resourcesKeys.host, host());
        if (selectedProjectId !== undefined) {
          client.setQueryData(
            resourcesKeys.project(selectedProjectId),
            project(),
          );
        }
      }}
    >
      {open === undefined ? (
        monitor
      ) : (
        <OpenOnMount selector={open}>{monitor}</OpenOnMount>
      )}
      {children}
    </WithQueryClient>
  );
}

/**
 * Two more hot readings after the seeded one, a poll apart in the cache's
 * eyes (each with its own `at`): the third in a row is what turns cpu into
 * a warning. Finite: it stops after the second write.
 */
function HotReadings() {
  const client = useQueryClient();
  useEffect(() => {
    const timers = [1, 2].map((step) =>
      window.setTimeout(() => {
        client.setQueryData(
          resourcesKeys.host,
          hostReading({ cpuPercent: 94 + step, ageSeconds: 0 }),
        );
        client.setQueryData(
          resourcesKeys.project(projectId),
          readyProject(
            containerReading({ cpuPercent: 97 + step, ageSeconds: 0 }),
          ),
        );
      }, step * 120),
    );
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [client]);
  return null;
}

export default {
  title: 'Resources/Monitor/Resource monitor',
  component: ResourceMonitor,
};

export const Default = {
  render: () => <Monitor />,
};

export const SandboxPopoverOpen = {
  render: () => <Monitor open={sandboxTrigger} />,
};

export const MachinePopoverOpen = {
  render: () => <Monitor open={machineTrigger} />,
};

export const IdleSandbox = {
  render: () => <Monitor project={() => readyProject(idleContainer())} />,
};

export const MemoryWarning = {
  render: () => <Monitor project={() => readyProject(saturatedContainer())} />,
};

export const MemoryWarningPopoverOpen = {
  render: () => (
    <Monitor
      project={() => readyProject(saturatedContainer())}
      open={sandboxTrigger}
    />
  ),
};

export const SustainedCpu = {
  render: () => (
    <Monitor
      host={() => hostReading({ cpuPercent: 96, ageSeconds: 0 })}
      project={() =>
        readyProject(containerReading({ cpuPercent: 99, ageSeconds: 0 }))
      }
    >
      <HotReadings />
    </Monitor>
  ),
};

export const NoProjectSelected = {
  render: () => <Monitor selectedProjectId={undefined} />,
};

export const PreparingEnvironment = {
  render: () => (
    <Monitor project={() => ({ status: 'pending', retryAfterSeconds: 1 })} />
  ),
};

export const PreparingEnvironmentPopoverOpen = {
  render: () => (
    <Monitor
      project={() => ({ status: 'pending', retryAfterSeconds: 1 })}
      open={sandboxTrigger}
    />
  ),
};

export const EnvironmentUnavailable = {
  render: () => <Monitor project={() => ({ status: 'expired' })} />,
};

export const ProviderCannotMeasure = {
  render: () => (
    <Monitor
      project={() =>
        readyProject({
          status: 'unavailable',
          at: new Date(Date.now() - 1000).toISOString(),
        })
      }
      open={sandboxTrigger}
    />
  ),
};

export const SandboxWithoutMemoryLimit = {
  render: () => (
    <Monitor
      project={() =>
        readyProject(containerReading({ memoryLimitBytes: undefined }))
      }
      open={sandboxTrigger}
    />
  ),
};

export const FirstMachineReading = {
  render: () => (
    <Monitor
      host={() => hostReading({ cpuPercent: undefined })}
      open={machineTrigger}
    />
  ),
};

export const StaleReading = {
  render: () => (
    <Monitor
      host={() => hostReading({ ageSeconds: 95 })}
      project={() => readyProject(containerReading({ ageSeconds: 95 }))}
      seeded
      reads={{
        host: () => new Promise<HostResources>(() => undefined),
        project: () => new Promise<ProjectResourcesResult>(() => undefined),
      }}
      open={machineTrigger}
    />
  ),
};

export const WaitingForFirstReading = {
  render: () => (
    <Monitor
      seeded={false}
      reads={{
        host: () => new Promise<HostResources>(() => undefined),
        project: () => new Promise<ProjectResourcesResult>(() => undefined),
      }}
    />
  ),
};
