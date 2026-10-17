import { Button } from 'desktop/ui/button';
import { ReadFeedback, TreeSkeleton } from 'desktop/ui/panels';
import { Toaster } from 'desktop/ui/sonner';
import { useState } from 'react';

import { PanelFrame } from '../support/sidebar-frame.js';

export default {
  title: 'desktop/ui/Panels/Read feedback',
  component: ReadFeedback,
};

/*
 * `ReadFeedback` draws nothing itself: it raises the window's "Unable to
 * update" toast while a read fails and dismisses it once the read succeeds.
 * The story mounts the `Toaster` the window has, beside the panel whose read
 * failed, and "Try again" clears the error the way a successful read does.
 */
const FailedRead = ({ refreshing }: { readonly refreshing: boolean }) => {
  const [error, setError] = useState<string | undefined>(
    'files/v1.list failed: the sandbox is not running.',
  );
  return (
    <div className="flex min-h-[30rem] items-start gap-4">
      <PanelFrame>
        <TreeSkeleton label="Loading files" />
      </PanelFrame>
      <ReadFeedback
        error={error}
        refreshing={refreshing}
        onRetry={() => setError(undefined)}
        toastId="story-read-feedback"
      />
      <Button
        size="sm"
        variant="outline"
        onClick={() =>
          setError('files/v1.list failed: the sandbox is not running.')
        }
      >
        Fail again
      </Button>
      <Toaster position="bottom-right" />
    </div>
  );
};

export const Failed = {
  render: () => <FailedRead refreshing={false} />,
};

export const Refreshing = {
  render: () => <FailedRead refreshing />,
};
