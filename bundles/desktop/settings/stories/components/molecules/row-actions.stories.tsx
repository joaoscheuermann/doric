import { PencilIcon, TrashIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import {
  type RowAction,
  RowActions,
} from '../../../src/client/components/molecules/row-actions.js';
import { controlFrame } from '../../support/frames.js';
import { OpenOnMount } from '../../support/open-on-mount.js';

const actions: readonly RowAction[] = [
  { label: 'Edit', icon: <PencilIcon />, onSelect: () => {} },
  {
    label: 'Remove provider',
    icon: <TrashIcon />,
    destructive: true,
    onSelect: () => {},
  },
];

/** The menu at the end of a table row, as the providers table draws it. */
function Row({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex w-96 items-center gap-2 rounded-lg border px-3 py-2 text-sm">
      <span className="font-medium">openrouter</span>
      <span className="text-muted-foreground">OpenRouter</span>
      {children}
    </div>
  );
}

export default {
  title: 'Settings/Molecules/Row actions',
  component: RowActions,
  decorators: [controlFrame],
};

export const Default = {
  render: () => (
    <Row>
      <RowActions label="openrouter" actions={actions} />
    </Row>
  ),
};

export const Open = {
  render: () => (
    <OpenOnMount
      steps={[
        {
          selector: '[aria-label="Actions for openrouter"]',
          gesture: 'pointerdown',
        },
      ]}
    >
      <Row>
        <RowActions label="openrouter" actions={actions} />
      </Row>
    </OpenOnMount>
  ),
};

export const SingleAction = {
  render: () => (
    <OpenOnMount
      steps={[
        {
          selector: '[aria-label="Actions for openrouter"]',
          gesture: 'pointerdown',
        },
      ]}
    >
      <Row>
        <RowActions label="openrouter" actions={actions.slice(0, 1)} />
      </Row>
    </OpenOnMount>
  ),
};
