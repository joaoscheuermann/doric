// `footer.tsx` — the view controls of a canvas: zoom out, the zoom reading (a
// click returns to 100%), zoom in, and centring the content on screen. A
// window may keep its own command bar; the conversation node has only these.

import { FocusIcon, MinusIcon, PlusIcon } from 'lucide-react';
import { memo, type ReactNode } from 'react';

import { Button } from '../components/button.js';
import { Separator } from '../components/separator.js';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '../components/tooltip.js';

export interface CanvasFooterProps {
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
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size={icon ? 'icon-sm' : 'sm'}
            aria-label={label}
            data-testid={testId}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The floating footer, bottom centre over the canvas (`papercraft-footer`):
 * `Diminuir zoom` (`papercraft-zoom-out`), the zoom reading as `Voltar a 100%`
 * (`papercraft-zoom-reset`), `Aumentar zoom` (`papercraft-zoom-in`), a
 * separator, `Centralizar` (`papercraft-center`). Memoised: only the reading
 * changes it.
 */
export const CanvasFooter = memo(function CanvasFooter({
  zoom,
  onZoomOut,
  onZoomReset,
  onZoomIn,
  onCenter,
}: CanvasFooterProps) {
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
});
