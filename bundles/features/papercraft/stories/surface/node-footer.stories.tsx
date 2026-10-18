import { TooltipProvider } from 'desktop/ui/tooltip';
import type { ComponentType } from 'react';

import {
  NodeFooter,
  type NodeFooterProps,
} from '../../src/client/surface/node-footer.js';
import { CanvasArea } from '../support/frame.js';

const noop = () => undefined;

const footer = (zoom: string): NodeFooterProps => ({
  zoom,
  onZoomOut: noop,
  onZoomReset: noop,
  onZoomIn: noop,
  onCenter: noop,
});

export default {
  title: 'Papercraft/Surface/Node footer',
  component: NodeFooter,
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
  render: () => <NodeFooter {...footer('100%')} />,
};

export const ZoomedOut = {
  render: () => <NodeFooter {...footer('67%')} />,
};

export const ZoomedIn = {
  render: () => <NodeFooter {...footer('250%')} />,
};
