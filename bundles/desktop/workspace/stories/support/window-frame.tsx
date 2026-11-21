// The desktop window the layouts fill: a fixed 1280×800 frame, so a view or
// template is seen at the size the app draws it. Surfaces sized to the
// viewport (`h-svh`) fill the frame instead.

import type { ComponentType, ReactNode } from 'react';

export function WindowFrame({
  children,
  height = 800,
  width = 1280,
}: {
  readonly children: ReactNode;
  readonly height?: number;
  readonly width?: number;
}) {
  return (
    <div
      className="layout-story-window bg-background text-foreground"
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        width,
        height,
        overflow: 'hidden',
        border: '1px solid var(--border)',
        borderRadius: 10,
      }}
    >
      <style>{'.layout-story-window .h-svh { height: 100%; }'}</style>
      {children}
    </div>
  );
}

/** The meta decorator of every template, view and element story. */
export const windowDecorator = (Story: ComponentType) => (
  <WindowFrame>
    <Story />
  </WindowFrame>
);
