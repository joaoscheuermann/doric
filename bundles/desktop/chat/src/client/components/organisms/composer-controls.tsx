import { Button } from 'desktop/ui/button';
import { SquareIcon } from 'lucide-react';
import { useStore } from 'zustand/react';

import { composerAction } from '../../domain/queue.js';
import type { Thread } from '../../domain/workspace.js';
import { useThreadQueue } from '../../hooks/use-thread-queue.js';
import { queueEditStore } from '../../stores/queue-edit.js';
import { ComposerButton } from '../molecules/composer-button.js';
import { ToolbarDivider } from '../molecules/toolbar-divider.js';

type ComposerControlsProps = {
  readonly thread?: Thread;
  /** Whether a prompt is running on the selected Thread. */
  readonly running: boolean;
  /** Whether the prompt holds anything to send. */
  readonly canSend: boolean;
  /** Whether there is a selected Thread to run a prompt on at all. */
  readonly disabled?: boolean;
  readonly onSend: () => void;
  readonly onStop: () => void;
};

/**
 * The composer's part of the conversation footer (`workspace-footer.tsx`
 * 62-88): the divider, "Stop execution" while a queued edit is open and the
 * Thread runs, and the send/stop/resume/save button.
 */
export function ComposerControls({
  canSend,
  disabled,
  thread,
  onSend,
  onStop,
  running,
}: ComposerControlsProps) {
  const queue = useThreadQueue(thread?.id);
  const edit = useStore(queueEditStore, (state) =>
    thread ? state.edits[thread.id] : undefined,
  );
  const action = edit ? 'save' : composerAction(running, queue.data);
  return (
    <>
      <ToolbarDivider />
      {edit && running && (
        <Button
          size="icon-sm"
          variant="default"
          aria-label="Stop execution"
          onClick={onStop}
        >
          <SquareIcon fill="currentColor" />
        </Button>
      )}
      <ComposerButton
        canSend={edit ? Boolean(edit.text.trim()) : canSend}
        disabled={
          disabled ||
          edit?.saving ||
          queue.resuming ||
          queue.data?.stopping ||
          (action === 'resume' && queue.isError)
        }
        onSend={onSend}
        onStop={onStop}
        action={action}
        onResume={queue.resume}
      />
    </>
  );
}
