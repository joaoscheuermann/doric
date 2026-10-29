// `toolbar.tsx` — the pieces of a canvas's floating command bar: the bar, its
// groups, the divider between them, the tooltip that names a control with its
// `<kbd>` shortcut, and the ghost icon button most controls are. Built from the
// registry's components (`Button`, `Separator`, `Tooltip`); what each control
// does is the owner's.

import type { ComponentProps, ReactElement, ReactNode } from 'react';

import { Button } from '../components/button.js';
import { Separator } from '../components/separator.js';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '../components/tooltip.js';
import { cn } from '../lib/utils.js';

/**
 * A floating bar of canvas controls: `role="toolbar"` named by `label`
 * (`aria-label`). Takes the other `div` attributes; `className` joins the
 * bar's own.
 */
export function CanvasToolbar({
  label,
  className,
  children,
  ...props
}: {
  readonly label: string;
  readonly className?: string;
  readonly children: ReactNode;
} & Omit<
  ComponentProps<'div'>,
  'children' | 'aria-label' | 'role'
>): ReactElement {
  return (
    <div
      {...props}
      role="toolbar"
      aria-label={label}
      className={cn(
        'flex items-center gap-1 rounded-xl border border-border bg-background/80 p-1 shadow-md backdrop-blur',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** One group of a toolbar: `role="group"`, named by `label` when given. */
export function ToolbarGroup({
  label,
  children,
}: {
  readonly label?: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a group of toolbar controls, not a form's fieldset.
    <div
      role="group"
      {...(label === undefined ? {} : { 'aria-label': label })}
      className="flex items-center gap-1"
    >
      {children}
    </div>
  );
}

/** A vertical divider between two groups, shorter than the bar. */
export function ToolbarSeparator(): ReactElement {
  return (
    <Separator
      orientation="vertical"
      className="mx-1 h-4 data-vertical:self-center"
    />
  );
}

/**
 * The tooltip of one control: its label and, when given, its `<kbd>`
 * shortcut. `children` is the control, rendered as the tooltip's trigger.
 */
export function ToolbarTooltip({
  label,
  shortcut,
  children,
}: {
  readonly label: string;
  readonly shortcut?: string;
  readonly children: ReactElement;
}): ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent className="flex items-center gap-1.5">
        <span>{label}</span>
        {shortcut === undefined ? null : (
          <kbd className="rounded border border-border bg-muted px-1 font-mono text-[10px]">
            {shortcut}
          </kbd>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * One toolbar control: a `Button` (ghost, `icon-sm` unless overridden) named
 * by `label` (`aria-label`), inside its `ToolbarTooltip`. Takes every other
 * `Button` prop.
 */
export function ToolbarButton({
  label,
  shortcut,
  children,
  ...props
}: {
  readonly label: string;
  readonly shortcut?: string;
  readonly children: ReactNode;
} & Omit<
  ComponentProps<typeof Button>,
  'children' | 'aria-label'
>): ReactElement {
  return (
    <ToolbarTooltip
      label={label}
      {...(shortcut === undefined ? {} : { shortcut })}
    >
      <Button variant="ghost" size="icon-sm" {...props} aria-label={label}>
        {children}
      </Button>
    </ToolbarTooltip>
  );
}
