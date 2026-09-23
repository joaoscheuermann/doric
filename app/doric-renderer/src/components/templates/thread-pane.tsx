import { Conversation } from '@/components/organisms/conversation';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import type { Thread } from '@/domain/workspace';
import { FileTextIcon } from 'lucide-react';

export function ThreadPane({
  thread,
}: {
  readonly thread: Thread | undefined;
}) {
  return (
    <section aria-label="Thread conversation" className="flex min-h-0 flex-1">
      {thread ? (
        <Conversation key={thread.id} thread={thread} />
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
