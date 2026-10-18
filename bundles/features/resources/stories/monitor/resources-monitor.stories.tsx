import { ResourcesMonitorView } from '../../src/client/monitor/resources-monitor.js';
import { WithQueryClient } from '../support/query.js';
import { readyProject, saturatedContainer } from '../support/resources.js';
import { fixtureWorkspace, monitorServices } from '../support/workspace.js';

export default {
  title: 'Resources/Monitor/Resources monitor',
  component: ResourcesMonitorView,
};

export const SelectedProject = {
  render: () => (
    <WithQueryClient>
      <ResourcesMonitorView services={monitorServices()} />
    </WithQueryClient>
  ),
};

export const SandboxNearMemoryLimit = {
  render: () => (
    <WithQueryClient>
      <ResourcesMonitorView
        services={monitorServices({
          project: () => readyProject(saturatedContainer()),
        })}
      />
    </WithQueryClient>
  ),
};

export const PreparingEnvironment = {
  render: () => (
    <WithQueryClient>
      <ResourcesMonitorView
        services={monitorServices({
          project: () => ({ status: 'pending', retryAfterSeconds: 1 }),
        })}
      />
    </WithQueryClient>
  ),
};

export const DashboardWithoutProject = {
  render: () => (
    <WithQueryClient>
      <ResourcesMonitorView
        services={monitorServices({ workspace: fixtureWorkspace(undefined) })}
      />
    </WithQueryClient>
  ),
};

export const WithoutLayout = {
  render: () => (
    <WithQueryClient>
      <ResourcesMonitorView services={monitorServices({ workspace: null })} />
    </WithQueryClient>
  ),
};
