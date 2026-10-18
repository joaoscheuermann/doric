// The footer's composer controls over a seeded Thread: its queue comes from
// the story host's `runtime.threads/v1` (already in the window's query
// client), and an open queued-prompt edit from the queue-edit store.

import type { ComponentType } from 'react';

import { ComposerControls } from '../../../src/client/components/organisms/composer-controls.js';
import { ChatHost } from '../../support/chat-host.js';
import { threadIds, threadQueues, threads } from '../../support/fixtures.js';
import { seedQueueEdit } from '../../support/queue-edit.js';

const send = (): void => console.info('Doric story: send');
const stop = (): void => console.info('Doric story: pause');

const editedItem = (threadId: string) => {
  const item = threadQueues[threadId]?.items[0];
  if (item === undefined) throw new Error('The fixture queue is empty.');
  return item;
};

export default {
  title: 'Chat/Organisms/Composer controls',
  component: ComposerControls,
  decorators: [
    (Story: ComponentType) => (
      <ChatHost>
        <footer
          className="flex chrome-bar items-center justify-end gap-2 border-t bg-sidebar px-2"
          data-slot="chat-thread-footer"
        >
          <Story />
        </footer>
      </ChatHost>
    ),
  ],
};

export const ReadyToSend = {
  render: () => (
    <ComposerControls
      thread={threads.composerIdle}
      running={false}
      canSend
      onSend={send}
      onStop={stop}
    />
  ),
};

export const EmptyPrompt = {
  render: () => (
    <ComposerControls
      thread={threads.composerIdle}
      running={false}
      canSend={false}
      onSend={send}
      onStop={stop}
    />
  ),
};

export const Running = {
  render: () => (
    <ComposerControls
      thread={threads.running}
      running
      canSend={false}
      onSend={send}
      onStop={stop}
    />
  ),
};

/** Paused queued work: the control resumes the queue. */
export const QueuedWork = {
  render: () => (
    <ComposerControls
      thread={threads.queued}
      running={false}
      canSend={false}
      onSend={send}
      onStop={stop}
    />
  ),
};

export const EditingQueuedPrompt = {
  render: () => {
    seedQueueEdit(
      threadIds.composerEditing,
      editedItem(threadIds.composerEditing),
      'Document the retry and timeout options of the API client.',
    );
    return (
      <ComposerControls
        thread={threads.composerEditing}
        running={false}
        canSend={false}
        onSend={send}
        onStop={stop}
      />
    );
  },
};

/** An edit open while the Thread runs: Pause execution beside Save. */
export const EditingWhileRunning = {
  render: () => {
    seedQueueEdit(
      threadIds.composerEditingRunning,
      editedItem(threadIds.composerEditingRunning),
      'Cache the TypeScript build info and the Vite cache in CI.',
    );
    return (
      <ComposerControls
        thread={threads.composerEditingRunning}
        running
        canSend={false}
        onSend={send}
        onStop={stop}
      />
    );
  },
};

/** The host is stopping the run: the control waits. */
export const Stopping = {
  render: () => (
    <ComposerControls
      thread={threads.composerStopping}
      running
      canSend={false}
      onSend={send}
      onStop={stop}
    />
  ),
};

/** The queue could not be read again: Resume is disabled. */
export const QueueUnreadable = {
  render: () => (
    <ComposerControls
      thread={threads.composerQueueError}
      running={false}
      canSend={false}
      onSend={send}
      onStop={stop}
    />
  ),
};

export const NoThread = {
  render: () => (
    <ComposerControls
      running={false}
      canSend={false}
      disabled
      onSend={send}
      onStop={stop}
    />
  ),
};
