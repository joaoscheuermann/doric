import { Button } from 'desktop/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from 'desktop/ui/tooltip';
import {
  BotIcon,
  type LucideProps,
  PauseIcon,
  PlayIcon,
  RotateCcwIcon,
} from 'lucide-react';
import type { ComponentType } from 'react';

import type { AgentControl, AgentStatus } from '../../domain/agent-control.js';
import { ToolbarDivider } from '../molecules/toolbar-divider.js';

/** What the agent Thread is doing, in one word beside its mark. */
const STATUS_LABEL: Record<AgentStatus, string> = {
  running: 'Running',
  paused: 'Paused',
  failed: 'Failed',
  idle: 'Finished',
};

/** The solid glyphs, as the composer's own play and stop are drawn. */
const SolidPlayIcon = (props: LucideProps) => (
  <PlayIcon fill="currentColor" {...props} />
);

/** One of the reader's three levers, disabled when the Thread is not in its state. */
function Lever({
  enabled,
  icon: Icon,
  label,
  onClick,
  hint,
}: {
  readonly enabled: boolean;
  readonly icon: ComponentType<LucideProps>;
  readonly label: string;
  readonly onClick: () => void;
  readonly hint: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            disabled={!enabled}
            size="icon-sm"
            variant={enabled ? 'outline' : 'ghost'}
            onClick={onClick}
          />
        }
      >
        <Icon />
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
}

/**
 * What an agent Thread carries where a reader Thread carries its composer
 * (`chat-composer.tsx`): who owns the Thread and the three levers the reader has
 * on it — pause the run, continue the prompt it left unfinished, or send the last
 * words once more. The reader writes nothing here, so nothing to type is drawn.
 */
export function AgentThreadControls({
  control,
  onContinue,
  onPause,
  onRetry,
}: {
  readonly control: AgentControl;
  readonly onContinue: () => void;
  readonly onPause: () => void;
  readonly onRetry: () => void;
}) {
  return (
    <>
      <span
        className="mr-auto flex min-w-0 items-center gap-1.5"
        title="An agent opened this thread. You can pause it, continue it or retry it."
      >
        <BotIcon aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="shrink-0">Agent thread</span>
        <span aria-hidden="true">·</span>
        <span className="truncate" role="status">
          {STATUS_LABEL[control.status]}
        </span>
      </span>
      <ToolbarDivider />
      <Lever
        enabled={control.canPause}
        hint="Pause the run"
        icon={PauseIcon}
        label="Pause agent thread"
        onClick={onPause}
      />
      <Lever
        enabled={control.canContinue}
        hint="Continue the paused prompt"
        icon={SolidPlayIcon}
        label="Continue agent thread"
        onClick={onContinue}
      />
      <Lever
        enabled={control.canRetry}
        hint="Retry the last prompt"
        icon={RotateCcwIcon}
        label="Retry agent thread"
        onClick={onRetry}
      />
    </>
  );
}
