import {
  CanvasHeader,
  type CanvasHeaderProps,
  gridBackground,
  IDENTITY,
} from 'desktop/ui/canvas';
import { TooltipProvider } from 'desktop/ui/tooltip';
import type { ComponentType, CSSProperties, ReactNode } from 'react';

/** The size of the bare canvas area the overlay stories draw on. */
const AREA = { width: 720, height: 480 } as const;

/** A bare canvas: the frame's dot grid, the room the overlays position in. */
function CanvasArea({
  children,
  height = AREA.height,
}: {
  readonly children?: ReactNode;
  readonly height?: number;
}) {
  const style: CSSProperties = {
    width: AREA.width,
    height,
    ...gridBackground(IDENTITY),
  };

  return (
    <div
      className="papercraft-container relative overflow-hidden rounded-lg border border-border bg-card"
      style={style}
    >
      {children}
    </div>
  );
}

const SOURCE = 'src/components/Checkout.tsx';

const noop = () => undefined;

const header = (
  overrides: Partial<CanvasHeaderProps> = {},
): CanvasHeaderProps => ({
  host: 'node',
  title: SOURCE,
  revision: 2,
  canExpand: true,
  onExpand: noop,
  commentActive: false,
  canComment: true,
  commentCount: 3,
  onToggleComment: noop,
  draftCount: 0,
  onSend: noop,
  ...overrides,
});

export default {
  title: 'desktop/ui/Canvas/Header',
  component: CanvasHeader,
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

/** The focused node: the title, the revision, `expandir` and the comment tool. */
export const Node = {
  render: () => <CanvasHeader {...header()} />,
};

/** The node out of focus: the title and the revision only. */
export const NodeUnfocused = {
  render: () => <CanvasHeader {...header({ controls: false })} />,
};

export const CommentModeOn = {
  render: () => <CanvasHeader {...header({ commentActive: true })} />,
};

export const NoComments = {
  render: () => <CanvasHeader {...header({ commentCount: 0 })} />,
};

/** A thread of the revision is resolved: the eye shows or hides its pin. */
export const ResolvedShown = {
  render: () => (
    <CanvasHeader
      {...header({ resolvedToggle: { shown: true, onToggle: noop } })}
    />
  ),
};

export const ResolvedHidden = {
  render: () => (
    <CanvasHeader
      {...header({ resolvedToggle: { shown: false, onToggle: noop } })}
    />
  ),
};

/** No composer stack to join, and no Thread to expand the node for. */
export const Unavailable = {
  render: () => (
    <CanvasHeader
      {...header({ canExpand: false, canComment: false, commentCount: 0 })}
    />
  ),
};

/** The node's modal: the 36px band, no `expandir`, and the send button while there are drafts. */
export const ModalWithDrafts = {
  render: () => <CanvasHeader {...header({ host: 'modal', draftCount: 2 })} />,
};

export const LongTitle = {
  render: () => (
    <CanvasHeader
      {...header({
        title:
          'src/features/billing/checkout/components/CheckoutSummaryWithSeatsAndCoupons.tsx',
        revision: 12,
      })}
    />
  ),
};
