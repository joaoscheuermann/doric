import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from 'desktop-ui/resizable';
import type { ReactNode } from 'react';

/**
 * The conversation over the bottom split: the `layout.main.bottom` region
 * (WP-10P, R-9.5; the terminal bundle's manual terminals since WP-10N),
 * shown while an item asked for the split.
 */
export function ConversationTerminals({
  children,
  bottom,
}: {
  readonly children: ReactNode;
  /** The region, present only while an item asked for the split. */
  readonly bottom?: ReactNode;
}) {
  return (
    <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
      <ResizablePanel minSize="20%" className="flex min-h-0 flex-col">
        {children}
      </ResizablePanel>
      {bottom && (
        <>
          <ResizableHandle />
          <ResizablePanel defaultSize="35%" minSize="6rem" className="min-h-0">
            {bottom}
          </ResizablePanel>
        </>
      )}
    </ResizablePanelGroup>
  );
}
