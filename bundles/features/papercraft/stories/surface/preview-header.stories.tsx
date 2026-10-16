import { TooltipProvider } from 'desktop/ui/tooltip';
import type { ComponentType } from 'react';

import {
  PreviewHeader,
  type PreviewHeaderProps,
} from '../../src/client/surface/preview-header.js';
import { CanvasArea } from '../support/frame.js';
import { SOURCE } from '../support/preview.js';

const noop = () => undefined;

const header = (
  overrides: Partial<PreviewHeaderProps> = {},
): PreviewHeaderProps => ({
  chrome: 'node',
  title: SOURCE,
  revision: 2,
  canOpen: true,
  onOpen: noop,
  commentActive: false,
  canComment: true,
  commentCount: 3,
  onToggleComment: noop,
  draftCount: 0,
  onSend: noop,
  ...overrides,
});

export default {
  title: 'Papercraft/Surface/Preview header',
  component: PreviewHeader,
  decorators: [
    (Story: ComponentType) => (
      <TooltipProvider>
        <CanvasArea height={96}>
          <Story />
        </CanvasArea>
      </TooltipProvider>
    ),
  ],
};

/** The focused node: the title, the revision, `abrir` and the comment tool. */
export const Node = {
  render: () => <PreviewHeader {...header()} />,
};

/** The node out of focus: the title and the revision only. */
export const NodeUnfocused = {
  render: () => <PreviewHeader {...header({ controls: false })} />,
};

export const CommentModeOn = {
  render: () => <PreviewHeader {...header({ commentActive: true })} />,
};

export const NoComments = {
  render: () => <PreviewHeader {...header({ commentCount: 0 })} />,
};

/** A thread of the revision is resolved: the eye shows or hides its pin. */
export const ResolvedShown = {
  render: () => (
    <PreviewHeader
      {...header({ resolvedToggle: { shown: true, onToggle: noop } })}
    />
  ),
};

export const ResolvedHidden = {
  render: () => (
    <PreviewHeader
      {...header({ resolvedToggle: { shown: false, onToggle: noop } })}
    />
  ),
};

/** No composer stack to join, and no Thread to open the window on. */
export const Unavailable = {
  render: () => (
    <PreviewHeader
      {...header({ canOpen: false, canComment: false, commentCount: 0 })}
    />
  ),
};

/** The window: no `abrir`, and the send button while there are drafts. */
export const CanvasWithDrafts = {
  render: () => (
    <PreviewHeader
      {...header({
        chrome: 'canvas',
        draftCount: 2,
        resolvedToggle: { shown: true, onToggle: noop },
      })}
    />
  ),
};

export const LongTitle = {
  render: () => (
    <PreviewHeader
      {...header({
        title:
          'src/features/billing/checkout/components/CheckoutSummaryWithSeatsAndCoupons.tsx',
        revision: 12,
      })}
    />
  ),
};
