import type { ReactNode } from 'react';

import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable';

export function ConversationTerminals({
  children,
  terminal,
}: {
  readonly children: ReactNode;
  readonly terminal?: ReactNode;
}) {
  return (
    <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
      <ResizablePanel minSize="20%" className="flex min-h-0 flex-col">
        {children}
      </ResizablePanel>
      {terminal && (
        <>
          <ResizableHandle />
          <ResizablePanel defaultSize="35%" minSize="6rem" className="min-h-0">
            {terminal}
          </ResizablePanel>
        </>
      )}
    </ResizablePanelGroup>
  );
}
