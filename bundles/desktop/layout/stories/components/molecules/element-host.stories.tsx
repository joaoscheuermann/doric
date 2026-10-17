import { ElementHost } from '../../../src/client/components/molecules/element-host.js';
import { planThread } from '../../support/data.js';
import { type LayoutFixture, LayoutHost } from '../../support/layout-host.js';

const terminals: LayoutFixture = { terminalRows: { [planThread.id]: 2 } };

export default {
  title: 'Layout/Molecules/Element host',
  component: ElementHost,
};

/** Another bundle's panel view, filling the host's parent. */
export const PanelView = {
  render: () => (
    <LayoutHost>
      <div className="flex h-80 w-80 flex-col bg-sidebar">
        <ElementHost
          tag="files-tree"
          props={{ label: 'Files', icon: 'files' }}
        />
      </div>
    </LayoutHost>
  ),
};

/** A badge element inside a bar. */
export const Badge = {
  render: () => (
    <LayoutHost>
      <div className="flex items-center gap-2 text-xs">
        Changes
        <ElementHost tag="git-changes-badge" />
      </div>
    </LayoutHost>
  ),
};

/** The terminal bundle's rows mounted under a Thread with two terminals. */
export const ThreadRows = {
  render: () => (
    <LayoutHost fixture={terminals}>
      <div className="w-60 bg-sidebar py-1">
        <ElementHost
          tag="terminal-rows"
          props={{ 'thread-id': planThread.id }}
        />
      </div>
    </LayoutHost>
  ),
};
