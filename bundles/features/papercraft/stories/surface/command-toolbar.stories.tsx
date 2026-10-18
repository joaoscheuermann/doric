import { TooltipProvider } from 'desktop/ui/tooltip';
import type { ComponentType } from 'react';

import {
  CommandToolbar,
  type CommandToolbarProps,
} from '../../src/client/surface/command-toolbar.js';
import { CanvasArea } from '../support/frame.js';
import { ARTIFACT_ID } from '../support/preview.js';

const toolbar = (
  overrides: Partial<CommandToolbarProps> = {},
): CommandToolbarProps => ({
  artifactId: ARTIFACT_ID,
  execute: () => undefined,
  tool: 'select',
  pinCount: 0,
  hasSelection: false,
  hasHidden: false,
  zoom: '100%',
  revisions: { current: 1, total: 1, list: [1], approved: false },
  approvalNeeded: false,
  ...overrides,
});

export default {
  title: 'Papercraft/Surface/Command toolbar',
  component: CommandToolbar,
  decorators: [
    (Story: ComponentType) => (
      <TooltipProvider>
        <CanvasArea height={120}>
          <Story />
        </CanvasArea>
      </TooltipProvider>
    ),
  ],
};

/** The window as it opens: `Selecionar` armed, one revision. */
export const Default = {
  render: () => <CommandToolbar {...toolbar()} />,
};

export const CommentArmed = {
  render: () => (
    <CommandToolbar {...toolbar({ tool: 'comment', pinCount: 4 })} />
  ),
};

export const PanArmed = {
  render: () => <CommandToolbar {...toolbar({ tool: 'pan', zoom: '150%' })} />,
};

/** A node selected and a layer hidden: `Isolar` and `Mostrar tudo` enable. */
export const WithSelection = {
  render: () => (
    <CommandToolbar
      {...toolbar({ hasSelection: true, hasHidden: true, pinCount: 2 })}
    />
  ),
};

/** Several revisions: the reading becomes the revision menu. */
export const Revisions = {
  render: () => (
    <CommandToolbar
      {...toolbar({
        revisions: { current: 2, total: 3, list: [1, 2, 3], approved: false },
      })}
    />
  ),
};

/** Under `request`, the revision on screen still to approve. */
export const ApprovalNeeded = {
  render: () => (
    <CommandToolbar
      {...toolbar({
        revisions: { current: 3, total: 3, list: [1, 2, 3], approved: false },
        approvalNeeded: true,
      })}
    />
  ),
};

export const Approved = {
  render: () => (
    <CommandToolbar
      {...toolbar({
        revisions: { current: 3, total: 3, list: [1, 2, 3], approved: true },
      })}
    />
  ),
};
