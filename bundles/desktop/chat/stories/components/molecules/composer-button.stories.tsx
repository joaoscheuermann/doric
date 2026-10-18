// Every state the conversation footer's one control takes, in one story: the
// glyph it wears, the label its tooltip states and whether it can be pressed.
// Send, stop, resume queue, save edit and the retry defined ahead of its footer
// sit together so the accent color, the thicker arrow, the solid play and the
// solid stop are judged side by side. Each row states only what changes between
// them; the story hands every one the same handlers.

import { TooltipProvider } from 'desktop/ui/tooltip';
import type { ComponentProps, ComponentType } from 'react';

import { ComposerButton } from '../../../src/client/components/molecules/composer-button.js';

const log = (what: string) => () => console.info(`Doric story: ${what}`);

const handlers = {
  onSend: log('send'),
  onStop: log('stop'),
  onResume: log('resume'),
  onRetry: log('retry'),
};

type Props = Omit<
  ComponentProps<typeof ComposerButton>,
  'onSend' | 'onStop' | 'onResume' | 'onRetry'
>;

type State = {
  /** What the footer is doing while the control wears this state. */
  readonly situation: string;
  /** The label the control states, repeated for a reader who cannot hover. */
  readonly label: string;
  readonly props: Props;
};

const states: readonly State[] = [
  {
    situation: 'A draft to send',
    label: 'Send (Cmd+Enter)',
    props: { action: 'send', canSend: true },
  },
  {
    situation: 'Nothing typed yet',
    label: 'Send (Cmd+Enter)',
    props: { action: 'send', canSend: false },
  },
  {
    situation: 'The prompt is running',
    label: 'Stop (Esc)',
    props: { action: 'pause', canSend: false },
  },
  {
    situation: 'Queued work waits for a resume',
    label: 'Resume queue',
    props: { action: 'resume', canSend: false },
  },
  {
    situation: 'A queued prompt is being edited',
    label: 'Save edit (Cmd/Ctrl+Enter)',
    props: { action: 'save', canSend: true },
  },
  {
    situation: 'The edited prompt is empty',
    label: 'Save edit (Cmd/Ctrl+Enter)',
    props: { action: 'save', canSend: false },
  },
  {
    situation: 'No Thread is selected',
    label: 'Stop (Esc)',
    props: { action: 'pause', canSend: false, disabled: true },
  },
  {
    // Defined ahead of the footer that will offer it: no call site chooses the
    // retry yet, so this state is drawn here and nowhere else.
    situation: 'A failed turn to run again',
    label: 'Retry',
    props: { action: 'retry', canSend: false },
  },
];

export default {
  title: 'Chat/Molecules/Composer button',
  component: ComposerButton,
  decorators: [
    (Story: ComponentType) => (
      <TooltipProvider>
        <Story />
      </TooltipProvider>
    ),
  ],
};

/** Every state of the composer's control, over the footer's own surface. */
export const States = {
  render: () => (
    <ul className="w-[24rem] divide-y divide-border overflow-hidden rounded-lg border bg-sidebar">
      {states.map(({ situation, label, props }) => (
        <li
          key={situation}
          className="flex items-center justify-between gap-6 px-3 py-2"
        >
          <span className="min-w-0">
            <span className="block truncate text-xs font-medium">
              {situation}
            </span>
            <span className="block truncate text-xs text-muted-foreground">
              {label}
            </span>
          </span>
          <ComposerButton {...props} {...handlers} />
        </li>
      ))}
    </ul>
  ),
};
