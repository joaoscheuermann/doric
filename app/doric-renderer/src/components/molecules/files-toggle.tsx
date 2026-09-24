import { Button } from '@/components/ui/button';
import { PanelRightCloseIcon, PanelRightOpenIcon } from 'lucide-react';

type FilesToggleProps = {
  /** Closes the panel when it is open, and opens it when it is closed. */
  readonly onToggle: () => void;
  /** Whether the panel is open, which is what the control says it will change. */
  readonly open?: boolean;
};

/**
 * The one control that shows and hides the Project's sandbox panel. It sits in
 * the panel's own header while the panel is open, and the main header carries it
 * at its right corner while the panel is closed, so exactly one of the two is on
 * screen: the control that reopens the panel is always at the right corner of
 * whatever is showing, in the same size as the sidebar's own toggle.
 */
export function FilesToggle({ onToggle, open = false }: FilesToggleProps) {
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
