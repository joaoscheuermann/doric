import { Badge } from 'desktop/ui/badge';
import { moveItem, type StripTab, TabStrip } from 'desktop/ui/panels';
import { Tabs } from 'desktop/ui/tabs';
import {
  FileCodeIcon,
  FileIcon,
  FolderIcon,
  GitCompareIcon,
  MessageSquareIcon,
  TerminalIcon,
} from 'lucide-react';
import { useState } from 'react';

import { threads } from '../support/doric.js';

export default {
  title: 'desktop/ui/Panels/Tab strip',
  component: TabStrip,
};

type Variant = 'line' | 'default' | 'toggle' | 'project';

/*
 * A strip keeps its own order and selection here, as the workspace's tab
 * store does: dragging (or Alt+Shift+Arrow) moves a tab, closing removes it.
 */
const Strip = ({
  initial,
  variant,
  closable = false,
  label,
}: {
  readonly initial: readonly StripTab[];
  readonly variant: Variant;
  readonly closable?: boolean;
  readonly label: string;
}) => {
  const [items, setItems] = useState(initial);
  const [selected, setSelected] = useState<string | undefined>(initial[0]?.id);
  const ids = items.map((item) => item.id);
  const strip = (
    <TabStrip
      items={items}
      selected={selected}
      label={label}
      variant={variant}
      onSelect={setSelected}
      onMove={(from, to) =>
        setItems((current) =>
          moveItem(current, ids.indexOf(from), ids.indexOf(to)),
        )
      }
      onClose={
        closable
          ? (id) => {
              setItems((current) => current.filter((item) => item.id !== id));
              if (id === selected)
                setSelected(ids.find((other) => other !== id));
            }
          : undefined
      }
    />
  );
  if (variant === 'toggle') return strip;
  return (
    <Tabs value={selected ?? ''} onValueChange={setSelected} className="gap-0">
      {strip}
    </Tabs>
  );
};

const workspaceTabs: readonly StripTab[] = [
  {
    id: 'thread-1',
    label: threads[0]?.title ?? 'Thread',
    icon: <MessageSquareIcon />,
  },
  {
    id: 'chrome-bar',
    label: 'chrome-bar.tsx',
    title: 'packages/desktop/src/chrome-bar.tsx',
    icon: <FileCodeIcon />,
  },
  {
    id: 'diff',
    label: 'sidebar.tsx',
    ariaLabel: 'Changes in sidebar.tsx',
    icon: <GitCompareIcon />,
  },
  { id: 'terminal', label: 'zsh — doric', icon: <TerminalIcon /> },
  { id: 'readme', label: 'GROUNDING.md', icon: <FileIcon /> },
];

const panelTabs: readonly StripTab[] = [
  { id: 'files', label: 'Files', icon: <FolderIcon /> },
  {
    id: 'changes',
    label: 'Changes',
    icon: <GitCompareIcon />,
    badge: <Badge variant="secondary">3</Badge>,
  },
  { id: 'terminal', label: 'Terminal', icon: <TerminalIcon /> },
];

export const Project = {
  render: () => (
    <div className="max-w-3xl">
      <Strip
        variant="project"
        initial={workspaceTabs}
        closable
        label="Files, changes, terminals and threads"
      />
    </div>
  ),
};

export const Line = {
  render: () => (
    <div className="max-w-xl">
      <Strip
        variant="line"
        initial={workspaceTabs}
        closable
        label="Open files"
      />
    </div>
  ),
};

export const Default = {
  render: () => <Strip variant="default" initial={panelTabs} label="Panels" />,
};

export const Toggle = {
  render: () => <Strip variant="toggle" initial={panelTabs} label="Panels" />,
};

export const IconOnly = {
  render: () => (
    <Strip
      variant="toggle"
      label="Panels"
      initial={panelTabs.map((tab) => ({ ...tab, iconOnly: true }))}
    />
  ),
};

export const Overflow = {
  render: () => (
    <div className="max-w-md">
      <Strip
        variant="project"
        closable
        label="Open files"
        initial={Array.from({ length: 12 }, (_, index) => ({
          id: `file-${index}`,
          label: `component-${index + 1}.stories.tsx`,
          icon: <FileCodeIcon />,
        }))}
      />
    </div>
  ),
};
