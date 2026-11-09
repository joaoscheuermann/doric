// The boxes the papercraft stories draw their parts in: the conversation
// column the node's square sits in, the canvas window, and a bare canvas area
// (the frame's dot grid) for the overlay parts. The conversation's parts sit
// on the window's inset card (ui-redesign S34): the `--sidebar` canvas, the
// `--background` card (radius 10, `shadow-sm`, no border), and on it the
// node's preview, itself a card (Figma `82:59323`: radius 10, `shadow-sm`, no
// border, 16 px of `--background` around it).

import type { ComponentType, CSSProperties, ReactNode } from 'react';

import { gridBackground, IDENTITY } from '../../src/client/surface/viewport.js';

/** The conversation's inset card on the window's canvas. */
export function InsetCard({ children }: { readonly children: ReactNode }) {
  return (
    <div className="bg-sidebar p-2">
      <div className="w-fit rounded-xl bg-background p-4 shadow-sm">
        {children}
      </div>
    </div>
  );
}

/** The conversation column a preview node sits in, on the inset card. */
export function ChatColumn({ children }: { readonly children: ReactNode }) {
  return (
    <div className="bg-sidebar p-2">
      <div className="rounded-xl bg-background p-4 shadow-sm">
        <div className="mx-auto w-full max-w-3xl">{children}</div>
      </div>
    </div>
  );
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

/**
 * A bare canvas: the frame's dot grid, the room the overlays position in,
 * drawn as the node's preview card on the inset card.
 */
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
    <InsetCard>
      <div
        className="papercraft-container relative overflow-hidden rounded-xl bg-card shadow-sm"
        style={style}
      >
        {children}
      </div>
    </InsetCard>
  );
}

/** A meta decorator that draws every story of a file on a bare canvas. */
export const onCanvas = (height?: number) => (Story: ComponentType) => (
  <CanvasArea {...(height === undefined ? {} : { height })}>
    <Story />
  </CanvasArea>
);
