/**
 * The one control that runs the conversation: it sends the prompt the reader
 * wrote, or stops the prompt the agent is running.
 *
 * It is one control for two commands: idle it sends, and while a prompt runs it
 * stops — which here means interrupting *that* prompt, not the Thread, whose
 * queue and daughters carry on.
 *
 * The keys are in the tooltip because they are how a reader who lives in the
 * editor sends and stops without leaving it.
 */
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { SendHorizontalIcon, SquareIcon } from 'lucide-react';

/**
 * The one control that runs the conversation: it sends the prompt the reader
 * wrote, or stops the prompt the agent is running.
 *
 * It is one control for two commands: idle it sends, and while a prompt runs it
 * stops — which here means interrupting *that* prompt, not the Thread, whose
 * queue and daughters carry on.
 *
 * The keys are in the tooltip, because they are how a reader who lives in the
 * editor sends and stops without leaving it.
 */
export function ComposerButton({
  canSend,
  disabled = false,
  onSend,
  onStop,
  running,
}: {
  /** Whether the prompt holds anything to send. */
  readonly canSend: boolean;
  /** Whether there is a conversation to run at all. */
  readonly disabled?: boolean;
  readonly onSend: () => void;
  readonly onStop: () => void;
  readonly running: boolean;
}) {
  const label = running ? 'Stop (Esc)' : 'Send (Cmd+Enter)';

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={label}
          disabled={disabled || (!running && !canSend)}
          size="icon-sm"
          variant="ghost"
          onClick={running ? onStop : onSend}
        >
          {/* The stop mark is a filled red square: the one thing in the footer
              that stops work, and the one thing that says so by colour. */}
          {running ? (
            <SquareIcon className="fill-destructive text-destructive" />
          ) : (
            <SendHorizontalIcon />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
