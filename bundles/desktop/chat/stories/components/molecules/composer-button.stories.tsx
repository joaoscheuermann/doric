import { TooltipProvider } from 'desktop/ui/tooltip';
import type { ComponentType } from 'react';

import { ComposerButton } from '../../../src/client/components/molecules/composer-button.js';

const log = (what: string) => () => console.info(`Doric story: ${what}`);

const handlers = {
  onSend: log('send'),
  onStop: log('pause'),
  onResume: log('resume'),
};

export default {
  title: 'Chat/Molecules/Composer button',
  component: ComposerButton,
  decorators: [
    // The footer bar the control sits at the end of.
    (Story: ComponentType) => (
      <TooltipProvider>
        <footer className="flex chrome-bar items-center justify-end gap-2 border-t bg-sidebar px-2">
          <Story />
        </footer>
      </TooltipProvider>
    ),
  ],
};

export const Send = {
  render: () => <ComposerButton action="send" canSend {...handlers} />,
};

export const SendEmptyPrompt = {
  render: () => <ComposerButton action="send" canSend={false} {...handlers} />,
};

export const Pause = {
  render: () => <ComposerButton action="pause" canSend={false} {...handlers} />,
};

export const ResumeQueue = {
  render: () => (
    <ComposerButton action="resume" canSend={false} {...handlers} />
  ),
};

export const SaveEdit = {
  render: () => <ComposerButton action="save" canSend {...handlers} />,
};

export const SaveEmptyEdit = {
  render: () => <ComposerButton action="save" canSend={false} {...handlers} />,
};

export const Disabled = {
  render: () => (
    <ComposerButton action="pause" canSend disabled {...handlers} />
  ),
};
