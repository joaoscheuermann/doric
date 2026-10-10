// <files-toggle placement> (stage 10, §3.6): the one control that shows and
// hides the Project panel (`molecules/files-toggle.tsx`). The main header
// carries it at its right corner while the panel is closed (`header`), and
// the panel's own header while it is open (`panel`), so exactly one of the
// two is on screen.

import type { Services } from 'bundle/contracts';
import { Button } from 'desktop-ui/button';
import { LayoutPanelV1 } from 'layout/contracts';
import { PanelRightCloseIcon, PanelRightOpenIcon } from 'lucide-react';

import { useService, useSubscribed } from '../hooks/use-service.js';

export type TogglePlacement = 'header' | 'panel';

export function FilesToggle({
  onToggle,
  open = false,
}: {
  /** Closes the panel when it is open, and opens it when it is closed. */
  readonly onToggle: () => void;
  /** Whether the panel is open, which is what the control says it will change. */
  readonly open?: boolean;
}) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={open ? 'Hide files' : 'Show files'}
      className="shrink-0 [app-region:no-drag]"
      onClick={onToggle}
    >
      {open ? <PanelRightCloseIcon /> : <PanelRightOpenIcon />}
    </Button>
  );
}

export function FilesToggleView({
  services,
  placement,
}: {
  readonly services: Services;
  readonly placement?: TogglePlacement;
}) {
  const panel = useService(services, LayoutPanelV1);
  const open = useSubscribed(
    panel,
    () => (panel as NonNullable<typeof panel>).isOpen(),
    false,
  );
  if (panel === undefined) return null;
  const toggle = () => panel.toggle();
  if (placement === 'panel') {
    return open ? <FilesToggle onToggle={toggle} open /> : null;
  }
  if (open) return null;
  return (
    <div className="flex h-full shrink-0 items-center pr-2">
      <FilesToggle onToggle={toggle} />
    </div>
  );
}
