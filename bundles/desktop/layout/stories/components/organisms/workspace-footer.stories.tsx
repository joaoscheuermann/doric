import { WorkspaceGlobalFooter } from '../../../src/client/components/organisms/workspace-footer.js';
import { type LayoutFixture, LayoutHost } from '../../support/layout-host.js';

const openSettings = () => console.info('Story: open settings');

const disconnected: LayoutFixture = { connection: 'disconnected' };
const bare: LayoutFixture = { regions: {} };

export default {
  title: 'Layout/Organisms/Workspace footer',
  component: WorkspaceGlobalFooter,
};

/** Connected, with the resources monitor the resources bundle adds. */
export const Connected = {
  render: () => (
    <LayoutHost>
      <WorkspaceGlobalFooter onOpenSettings={openSettings} />
    </LayoutHost>
  ),
};

export const Disconnected = {
  render: () => (
    <LayoutHost fixture={disconnected}>
      <WorkspaceGlobalFooter onOpenSettings={openSettings} />
    </LayoutHost>
  ),
};

/** No bundle added to the global footer: the status and settings alone. */
export const NoRegionItems = {
  render: () => (
    <LayoutHost fixture={bare}>
      <WorkspaceGlobalFooter onOpenSettings={openSettings} />
    </LayoutHost>
  ),
};
