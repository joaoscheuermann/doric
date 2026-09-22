import type { Thread } from '@/app/workspace';
import { Conversation } from '@/chat/conversation';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { FileTextIcon } from 'lucide-react';

export function ThreadPane({
  thread,
  threadName,
}: {
  readonly thread: Thread | undefined;
  readonly threadName?: (id: string) => string | undefined;
}) {
  return (
    <section aria-label="Thread conversation" className="flex min-h-0 flex-1">
      {thread ? (
        <Conversation key={thread.id} thread={thread} threadName={threadName} />
      ) : (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FileTextIcon />
            </EmptyMedia>
            <EmptyTitle>No thread selected</EmptyTitle>
            <EmptyDescription>
              Select a thread to open its conversation.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </section>
  );
}
