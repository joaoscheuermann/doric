import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { ArrowUpIcon, CheckIcon, PauseIcon, PlayIcon } from 'lucide-react';

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
    pause: PauseIcon,
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
          variant="ghost"
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
