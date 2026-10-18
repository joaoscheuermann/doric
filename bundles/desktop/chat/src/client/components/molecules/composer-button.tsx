import { Button } from 'desktop/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from 'desktop/ui/tooltip';
import {
  ArrowUpIcon,
  CheckIcon,
  type LucideProps,
  PlayIcon,
  RotateCcwIcon,
  SquareIcon,
} from 'lucide-react';

/**
 * The send glyph, a touch thicker than the drawn default: the arrow alone
 * inside the filled button reads light beside the solid stop.
 */
const SendIcon = (props: LucideProps) => (
  <ArrowUpIcon strokeWidth={2.5} {...props} />
);

/**
 * The solid glyphs the control wears: inside its filled button an outline
 * alone reads faint, so the play and the stop carry their whole fill.
 */
const SolidPlayIcon = (props: LucideProps) => (
  <PlayIcon fill="currentColor" {...props} />
);

const SolidStopIcon = (props: LucideProps) => (
  <SquareIcon fill="currentColor" {...props} />
);

/** One control sends a draft, resumes queued work, or stops the running prompt. */
export function ComposerButton({
  canSend,
  disabled = false,
  onSend,
  onStop,
  onResume,
  onRetry,
  action,
}: {
  readonly canSend: boolean;
  readonly disabled?: boolean;
  readonly onSend: () => void;
  readonly onStop: () => void;
  readonly onResume: () => void;
  /**
   * Nothing reaches a retry yet — `composerAction` never picks one — so the
   * state is defined ahead of the footer that will offer it.
   */
  readonly onRetry?: () => void;
  readonly action: 'send' | 'resume' | 'pause' | 'save' | 'retry';
}) {
  const label = {
    send: 'Send (Cmd+Enter)',
    resume: 'Resume queue',
    pause: 'Stop (Esc)',
    save: 'Save edit (Cmd/Ctrl+Enter)',
    retry: 'Retry',
  }[action];
  const Icon = {
    send: SendIcon,
    resume: SolidPlayIcon,
    pause: SolidStopIcon,
    save: CheckIcon,
    retry: RotateCcwIcon,
  }[action];
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            disabled={
              disabled || ((action === 'send' || action === 'save') && !canSend)
            }
            size="icon-sm"
            variant="default"
            onClick={
              {
                send: onSend,
                resume: onResume,
                pause: onStop,
                save: onSend,
                retry: onRetry,
              }[action]
            }
          />
        }
      >
        <Icon />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
