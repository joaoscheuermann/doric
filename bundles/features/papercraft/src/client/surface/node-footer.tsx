// `node-footer.tsx` — the view controls of the conversation node: zoom out,
// the zoom reading (a click returns to 100%), zoom in, and centring the
// element on screen. The window keeps its own command bar; the node, square
// and inside the conversation, has only these.

import { Button } from 'desktop/ui/button';
import { Separator } from 'desktop/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from 'desktop/ui/tooltip';
import { FocusIcon, MinusIcon, PlusIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export interface NodeFooterProps {
  /** The zoom reading, `100%` at identity. */
  readonly zoom: string;
  readonly onZoomOut: () => void;
  readonly onZoomReset: () => void;
  readonly onZoomIn: () => void;
  readonly onCenter: () => void;
}

function Control({
  label,
  onClick,
  children,
  testId,
  icon = true,
}: {
  readonly label: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
  readonly testId: string;
  readonly icon?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size={icon ? 'icon-sm' : 'sm'}
          aria-label={label}
          data-testid={testId}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** The node's floating footer, bottom centre over the canvas. */
export function NodeFooter({
  zoom,
  onZoomOut,
  onZoomReset,
  onZoomIn,
  onCenter,
}: NodeFooterProps) {
  return (
    <div
      data-testid="papercraft-footer"
      className="absolute inset-x-0 bottom-2 z-30 mx-auto flex w-fit items-center gap-0.5 rounded-lg border border-border bg-background/80 p-0.5 shadow-sm backdrop-blur"
    >
      <Control
        label="Diminuir zoom"
        testId="papercraft-zoom-out"
        onClick={onZoomOut}
      >
        <MinusIcon aria-hidden="true" />
      </Control>
      <Control
        label="Voltar a 100%"
        testId="papercraft-zoom-reset"
        icon={false}
        onClick={onZoomReset}
      >
        <span className="min-w-9 tabular-nums">{zoom}</span>
      </Control>
      <Control
        label="Aumentar zoom"
        testId="papercraft-zoom-in"
        onClick={onZoomIn}
      >
        <PlusIcon aria-hidden="true" />
      </Control>
      <Separator
        orientation="vertical"
        // The primitive stretches a vertical rule; a short one is centred.
        className="mx-0.5 h-4 data-vertical:self-center"
      />
      <Control
        label="Centralizar"
        testId="papercraft-center"
        onClick={onCenter}
      >
        <FocusIcon aria-hidden="true" />
      </Control>
    </div>
  );
}
