import { Button } from 'desktop/ui/button';
import {
  CanvasHeader,
  type CanvasHeaderProps,
  CanvasModal,
  gridBackground,
  IDENTITY,
} from 'desktop/ui/canvas';
import { TooltipProvider } from 'desktop/ui/tooltip';
import { type ComponentType, type ReactNode, useState } from 'react';

const TITLE = 'src/components/Checkout.tsx';

const noop = () => undefined;

const header = (
  overrides: Partial<CanvasHeaderProps> = {},
): CanvasHeaderProps => ({
  host: 'modal',
  title: TITLE,
  revision: 2,
  canExpand: true,
  onExpand: noop,
  commentActive: false,
  canComment: true,
  commentCount: 1,
  onToggleComment: noop,
  draftCount: 0,
  onSend: noop,
  ...overrides,
});

/** The canvas the modal holds: the dot grid under the modal's header band. */
function Canvas({ children }: { readonly children?: ReactNode }) {
  return (
    <div
      className="papercraft-container relative h-full w-full"
      style={gridBackground(IDENTITY)}
    >
      {children}
    </div>
  );
}

/** A modal its own button opens, and every close request closes. */
function Demo({
  initiallyOpen,
  headerProps,
}: {
  readonly initiallyOpen: boolean;
  readonly headerProps?: Partial<CanvasHeaderProps>;
}) {
  const [open, setOpen] = useState(initiallyOpen);

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Expandir
      </Button>
      <CanvasModal
        open={open}
        title={TITLE}
        onCloseRequest={() => setOpen(false)}
      >
        <Canvas>
          <CanvasHeader {...header(headerProps)} />
        </Canvas>
      </CanvasModal>
    </>
  );
}

export default {
  title: 'desktop/ui/Canvas/Modal',
  component: CanvasModal,
  decorators: [
    (Story: ComponentType) => (
      <TooltipProvider>
        <Story />
      </TooltipProvider>
    ),
  ],
};

/** The node's canvas expanded over the conversation, 12px from the edges. */
export const Open = {
  render: () => <Demo initiallyOpen />,
};

/** Closed: only the button that opens it. */
export const Closed = {
  render: () => <Demo initiallyOpen={false} />,
};

/** The modal's header with drafts: the send button beside the close button. */
export const HeaderWithDrafts = {
  render: () => <Demo initiallyOpen headerProps={{ draftCount: 2 }} />,
};
