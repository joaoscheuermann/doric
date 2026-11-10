import { useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect } from 'react';

import {
  cpuLabel,
  type HostResources,
  memoryLabel,
  type ProjectResourcesResult,
} from '../../src/client/domain/resources.js';
import { resourcesKeys } from '../../src/client/hooks/use-resources.js';
import { ConnectionBadge } from '../../src/client/monitor/connection-badge.js';
import {
  type ResourceSectionModel,
  ResourcesPopoverBody,
  type ResourcesSnapshot,
} from '../../src/client/monitor/resource-monitor.js';
import { OpenOnMount, WithQueryClient } from '../support/query.js';
import {
  fixtureReads,
  hostReading,
  projectId,
  readyProject,
  saturatedContainer,
} from '../support/resources.js';

const GiB = 1024 ** 3;
const badgeTrigger = '[data-slot="connection-badge"]';

/**
 * The badge over fixture reads, with the readings already in the cache (as
 * after the first poll), on the sidebar surface it is cut out of.
 */
function Badge({
  host = hostReading,
  project = () => readyProject(),
  connected = true,
  open = false,
  children,
}: {
  readonly host?: () => HostResources;
  readonly project?: () => ProjectResourcesResult;
  readonly connected?: boolean;
  readonly open?: boolean;
  readonly children?: ReactNode;
}) {
  const badge = (
    <ConnectionBadge
      reads={fixtureReads({ host, project })}
      projectId={projectId}
      connected={connected}
    />
  );
  return (
    <WithQueryClient
      seed={(client) => {
        client.setQueryData(resourcesKeys.host, host());
        client.setQueryData(resourcesKeys.project(projectId), project());
      }}
    >
      <div className="inline-flex rounded-md bg-sidebar p-2">
        {open ? (
          <OpenOnMount selector={badgeTrigger}>{badge}</OpenOnMount>
        ) : (
          badge
        )}
      </div>
      {children}
    </WithQueryClient>
  );
}

/**
 * Two more hot readings after the seeded one, each with its own `at`: the
 * third in a row is what turns cpu into a warning. Finite: it stops after
 * the second write.
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
      }, step * 120),
    );
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [client]);
  return null;
}

export default {
  title: 'Resources/Monitor/Connection badge',
  component: ConnectionBadge,
};

export const Connected = {
  render: () => <Badge />,
};

export const Disconnected = {
  render: () => <Badge connected={false} />,
};

export const MemoryWarning = {
  render: () => <Badge project={() => readyProject(saturatedContainer())} />,
};

export const SustainedCpu = {
  render: () => (
    <Badge host={() => hostReading({ cpuPercent: 96, ageSeconds: 0 })}>
      <HotReadings />
    </Badge>
  ),
};

export const PopoverOpen = {
  render: () => <Badge open />,
};

export const DisconnectedPopoverOpen = {
  render: () => <Badge connected={false} open />,
};

/** A section as a poll would leave it, with the labels the model computes. */
const section = (
  title: ResourceSectionModel['title'],
  input: {
    readonly used?: number;
    readonly limit?: number;
    readonly cpu?: number;
    readonly memoryWarning?: boolean;
    readonly cpuWarning?: boolean;
    readonly notice?: string;
  },
): ResourceSectionModel => ({
  title,
  memory: memoryLabel(input.used, input.limit),
  cpu: cpuLabel(input.cpu),
  memoryWarning: input.memoryWarning ?? false,
  cpuWarning: input.cpuWarning ?? false,
  memoryRatio:
    input.used !== undefined && input.limit !== undefined
      ? input.used / input.limit
      : undefined,
  cpuRatio: input.cpu === undefined ? undefined : input.cpu / 100,
  notice: input.notice,
});

const ago = (seconds: number): string =>
  new Date(Date.now() - seconds * 1000).toISOString();

const sandbox = section('Sandbox', {
  used: 1.2 * GiB,
  limit: 4 * GiB,
  cpu: 23,
});
const machine = section('Machine', {
  used: 18.4 * GiB,
  limit: 32 * GiB,
  cpu: 15,
});

/** The popover's body on the popover surface, as `32:1463` draws each state. */
function Body({
  connected = true,
  snapshot,
}: {
  readonly connected?: boolean;
  readonly snapshot: ResourcesSnapshot;
}) {
  return (
    <div className="w-64 rounded-lg bg-popover p-3 text-popover-foreground ring-1 ring-foreground/10">
      <ResourcesPopoverBody connected={connected} snapshot={snapshot} />
    </div>
  );
}

export const PopoverDefault = {
  render: () => <Body snapshot={{ sandbox, machine, at: ago(2) }} />,
};

export const PopoverMemoryWarning = {
  render: () => (
    <Body
      snapshot={{
        sandbox: section('Sandbox', {
          used: 3.6 * GiB,
          limit: 4 * GiB,
          cpu: 61,
          memoryWarning: true,
        }),
        machine,
        at: ago(2),
      }}
    />
  ),
};

export const PopoverCpuSustained = {
  render: () => (
    <Body
      snapshot={{
        sandbox: section('Sandbox', {
          used: 1.2 * GiB,
          limit: 4 * GiB,
          cpu: 99,
          cpuWarning: true,
        }),
        machine: section('Machine', {
          used: 18.4 * GiB,
          limit: 32 * GiB,
          cpu: 96,
          cpuWarning: true,
        }),
        at: ago(2),
      }}
    />
  ),
};

export const PopoverNoMemoryLimit = {
  render: () => (
    <Body
      snapshot={{
        sandbox: section('Sandbox', { used: 1.2 * GiB, cpu: 23 }),
        machine,
        at: ago(180),
      }}
    />
  ),
};

export const PopoverPreparing = {
  render: () => (
    <Body
      snapshot={{
        sandbox: section('Sandbox', { notice: 'Preparing environment…' }),
        machine,
        at: ago(2),
      }}
    />
  ),
};

export const PopoverUnavailable = {
  render: () => (
    <Body
      snapshot={{
        sandbox: section('Sandbox', {
          notice: 'Resources unavailable in this provider',
        }),
        machine,
        at: ago(2),
      }}
    />
  ),
};

export const PopoverDisconnected = {
  render: () => (
    <Body connected={false} snapshot={{ sandbox, machine, at: ago(180) }} />
  ),
};

export const PopoverWaitingForFirstReading = {
  render: () => (
    <Body
      snapshot={{
        sandbox: section('Sandbox', {}),
        machine: section('Machine', {}),
      }}
    />
  ),
};
