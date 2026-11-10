import { Button } from 'desktop/ui/button';
import { ButtonGroup } from 'desktop/ui/button-group';
import { ArrowLeftIcon, ArrowRightIcon } from 'lucide-react';

export default {
  title: 'desktop/ui/Button group',
  component: ButtonGroup,
};

/**
 * The sidebar header's Back/Forward (Figma `349:95531` ghost, `349:95622`):
 * two ghost `icon-sm` buttons joined with no gap, 14 px arrows, the outer
 * corners at `--radius-md` as the layout draws them.
 */
const History = ({
  canGoBack,
  canGoForward,
}: {
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}) => (
  <ButtonGroup
    aria-label="History"
    className="[&>[data-slot]:not(:has(~[data-slot]))]:rounded-r-md!"
  >
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Back"
      disabled={!canGoBack}
      className="in-data-[slot=button-group]:rounded-md"
    >
      <ArrowLeftIcon aria-hidden="true" className="size-3.5" />
    </Button>
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Forward"
      disabled={!canGoForward}
      className="in-data-[slot=button-group]:rounded-md"
    >
      <ArrowRightIcon aria-hidden="true" className="size-3.5" />
    </Button>
  </ButtonGroup>
);

const states = [
  { label: 'Both enabled', canGoBack: true, canGoForward: true },
  { label: 'Back only', canGoBack: true, canGoForward: false },
  { label: 'Both disabled', canGoBack: false, canGoForward: false },
] as const;

const Rows = () => (
  <div className="flex flex-col gap-3 bg-sidebar p-4 text-sidebar-foreground">
    {states.map(({ label, ...history }) => (
      <div key={label} className="flex items-center gap-4">
        <History {...history} />
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
    ))}
  </div>
);

export const Ghost = {
  render: () => <Rows />,
};

/** The same group inside `.dark`, whatever the page's theme. */
export const Dark = {
  render: () => (
    <div className="dark">
      <Rows />
    </div>
  ),
};
