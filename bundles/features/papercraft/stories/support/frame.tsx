// The boxes the papercraft stories draw their parts in: the conversation
// column the node's square sits in, the canvas window, and a bare canvas area
// (the frame's dot grid) for the overlay parts.

import { gridBackground, IDENTITY } from 'desktop/ui/canvas';
import type { ComponentType, CSSProperties, ReactNode } from 'react';

/** The conversation column a preview node sits in. */
export function ChatColumn({ children }: { readonly children: ReactNode }) {
  return <div className="mx-auto w-full max-w-3xl">{children}</div>;
}

/** The canvas window, as the route fills it below the title bar. */
export function CanvasWindow({ children }: { readonly children: ReactNode }) {
  return (
    <div
      className="relative overflow-hidden rounded-lg border border-border"
      style={{ height: 720 }}
    >
      {children}
    </div>
  );
}

/** The size of the bare canvas area the overlay stories draw on. */
export const AREA = { width: 720, height: 480 } as const;

/** A bare canvas: the frame's dot grid, the room the overlays position in. */
export function CanvasArea({
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

/** A meta decorator that draws every story of a file on a bare canvas. */
export const onCanvas = (height?: number) => (Story: ComponentType) => (
  <CanvasArea {...(height === undefined ? {} : { height })}>
    <Story />
  </CanvasArea>
);
