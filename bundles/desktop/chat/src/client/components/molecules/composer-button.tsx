import { Button } from 'desktop/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from 'desktop/ui/tooltip';
import {
  ArrowUpIcon,
  CheckIcon,
  type LucideProps,
  PauseIcon,
  PlayIcon,
} from 'lucide-react';

/**
 * A pause drawn solid: inside the solid footer button the outline alone reads
 * faint, so the icon carries its whole fill.
 */
const SolidPauseIcon = (props: LucideProps) => (
  <PauseIcon fill="currentColor" {...props} />
);

/** One control sends a draft, resumes queued work, or pauses dispatch. */
export function ComposerButton({
  canSend,
  disabled = false,
  onSend,
  onStop,
  onResume,
  action,
}: {
  readonly canSend: boolean;
  readonly disabled?: boolean;
  readonly onSend: () => void;
  readonly onStop: () => void;
  readonly onResume: () => void;
  readonly action: 'send' | 'resume' | 'pause' | 'save';
}) {
  const label = {
    send: 'Send (Cmd+Enter)',
    resume: 'Resume queue',
    pause: 'Pause (Esc)',
    save: 'Save edit (Cmd/Ctrl+Enter)',
  }[action];
  const Icon = {
    send: ArrowUpIcon,
    resume: PlayIcon,
    pause: SolidPauseIcon,
    save: CheckIcon,
  }[action];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={label}
          disabled={
            disabled || ((action === 'send' || action === 'save') && !canSend)
          }
          size="icon-sm"
          variant="solid"
          onClick={
            { send: onSend, resume: onResume, pause: onStop, save: onSend }[
              action
            ]
          }
        >
          <Icon />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
