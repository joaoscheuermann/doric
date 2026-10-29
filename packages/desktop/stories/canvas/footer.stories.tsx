import {
  CanvasFooter,
  type CanvasFooterProps,
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

const noop = () => undefined;

const footer = (zoom: string): CanvasFooterProps => ({
  zoom,
  onZoomOut: noop,
  onZoomReset: noop,
  onZoomIn: noop,
  onCenter: noop,
});

export default {
  title: 'desktop/ui/Canvas/Footer',
  component: CanvasFooter,
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

export const Identity = {
  render: () => <CanvasFooter {...footer('100%')} />,
};

export const ZoomedOut = {
  render: () => <CanvasFooter {...footer('67%')} />,
};

export const ZoomedIn = {
  render: () => <CanvasFooter {...footer('250%')} />,
};
