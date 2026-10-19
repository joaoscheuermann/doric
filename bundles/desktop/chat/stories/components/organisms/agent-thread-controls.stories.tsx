import type { ComponentType } from 'react';

import { AgentThreadControls } from '../../../src/client/components/organisms/agent-thread-controls.js';
import type { AgentControl } from '../../../src/client/domain/agent-control.js';

const control = (overrides: Partial<AgentControl>): AgentControl => ({
  status: 'idle',
  canPause: false,
  canContinue: false,
  canRetry: false,
  ...overrides,
});

const report = (name: string) => () => console.info(`Story action: ${name}`);

export default {
  title: 'Chat/Organisms/Agent thread controls',
  component: AgentThreadControls,
  decorators: [
    (Story: ComponentType) => (
      <footer className="flex chrome-bar w-full max-w-2xl items-center justify-end gap-2 border-t bg-sidebar px-2 text-xs text-muted-foreground">
        <Story />
      </footer>
    ),
  ],
  args: {
    onContinue: report('continue'),
    onPause: report('pause'),
    onRetry: report('retry'),
  },
};

/** The agent is running: only Pause applies. */
export const Running = {
  args: {
    control: control({
      status: 'running',
      canPause: true,
      retryText: 'Find out why the checkout test flakes in CI.',
    }),
  },
};

/** The reader paused the run: only Continue applies. */
export const Paused = {
  args: {
    control: control({
      status: 'paused',
      canContinue: true,
      pausedPromptId: 'a0000000-0000-4000-8000-000000000602',
      retryText: 'Map every error state the checkout form can reach.',
    }),
  },
};

/** The prompt failed: only Retry applies, and it sends the last words again. */
export const Failed = {
  args: {
    control: control({
      status: 'failed',
      canRetry: true,
      retryText: 'Summarize the payment diff for the release notes.',
    }),
  },
};

/** The agent finished its work: Retry runs the last prompt once more. */
export const Finished = {
  args: {
    control: control({
      status: 'idle',
      canRetry: true,
      retryText: 'Audit the bundle size.',
    }),
  },
};
