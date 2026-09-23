import { EditableName } from '@/components/molecules/editable-name';
import { Button } from '@/components/ui/button';
import { TabsTrigger } from '@/components/ui/tabs';
import type { Thread } from '@/domain/workspace';
import { cn } from '@/utility/utils';
import { XIcon } from 'lucide-react';
import type { PointerEvent } from 'react';

type ThreadTabProps = {
  /** Whether this Thread is the selected one. */
  readonly active: boolean;
  /** Which side the reorder drop indicator sits on, if this tab is the target. */
  readonly dropIndicator: 'before' | 'after' | undefined;
  /** Whether this tab's name is being edited inline. */
  readonly editing: boolean;
  /** Whether this tab is the one being dragged. */
  readonly lifted: boolean;
  readonly onClose: () => void;
  readonly onDragStart: (event: PointerEvent<HTMLDivElement>) => void;
  readonly onEditEnd: () => void;
  readonly onEditStart: () => void;
  readonly onRename: (name: string) => Promise<void>;
  readonly thread: Thread;
};

/**
 * One Thread in the workspace tab bar: its label, inline rename and the pointer
 * press that starts a reorder drag. It holds no state of its own — which tab is
 * open, edited or dragged is the bar's to know — and reports each interaction
 * through the callbacks above.
 */
export function ThreadTab({
  active,
  dropIndicator,
  editing,
  lifted,
  onClose,
  onDragStart,
  onEditEnd,
  onEditStart,
  onRename,
  thread,
}: ThreadTabProps) {
  return (
    <div
      className={cn(
        'group/tab relative -ml-px h-full flex-none first:ml-0 [app-region:no-drag]',
        active && 'z-10',
        lifted && 'opacity-60',
      )}
    >
      <TabsTrigger asChild value={thread.id}>
        <div
          data-thread-tab={thread.id}
          onPointerDown={(event) => {
            if (editing || event.button !== 0) return;
            onDragStart(event);
          }}
          className={cn(
            'relative flex h-full! w-fit max-w-64 flex-none items-center gap-0! rounded-none! py-0 pr-7 pl-2 text-xs shadow-none! after:content-none [app-region:no-drag]',
            active
              ? 'border-t-border! border-r-border! border-b-transparent! border-l-border! bg-background!'
              : 'border-t-transparent! border-r-border! border-b-transparent! border-l-transparent!',
          )}
        >
          <EditableName
            className="flex-none! max-w-56"
            editing={editing}
            label="Thread name"
            value={thread.name}
            onStart={onEditStart}
            onCancel={onEditEnd}
            onSubmit={async (name) => {
              await onRename(name);
              onEditEnd();
            }}
          />
          {dropIndicator !== undefined && (
            <span
              aria-hidden
              className={cn(
                'pointer-events-none absolute inset-y-0 w-0.5 bg-primary',
                dropIndicator === 'before' ? 'left-0' : 'right-0',
              )}
            />
          )}
        </div>
      </TabsTrigger>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        data-tab-close
        aria-label={`Close ${thread.name}`}
        className="absolute top-1 right-1 opacity-0 transition-opacity group-hover/tab:opacity-100 group-focus-within/tab:opacity-100 [app-region:no-drag]"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          onEditEnd();
          onClose();
        }}
      >
        <XIcon className="size-3" />
      </Button>
    </div>
  );
}
