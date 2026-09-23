import { ThreadTab } from '@/components/molecules/thread-tab';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { useSidebar } from '@/components/ui/sidebar';
import { Tabs, TabsList } from '@/components/ui/tabs';
import {
  type DropTarget,
  dropTargetFor,
  type Thread,
} from '@/domain/workspace';
import { PanelLeftCloseIcon, PanelLeftOpenIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

type MoveThreadTab = (
  sourceId: string,
  targetId: string,
  position: 'before' | 'after',
) => void;

type WorkspaceHeaderProps = {
  readonly onCloseThread: (id: string) => void;
  readonly onMoveThread: MoveThreadTab;
  readonly onRenameThread: (thread: Thread, name: string) => Promise<void>;
  readonly onSelectThread: (thread: Thread) => void;
  readonly selectedThreadId?: string;
  readonly threads: readonly Thread[];
};

/** Pointer travel, in pixels, before a press on a tab becomes a reorder drag. */
const dragThreshold = 4;

function SidebarToggle() {
  const { open, toggleSidebar } = useSidebar();

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={open ? 'Hide sidebar' : 'Show sidebar'}
      className="self-center [app-region:no-drag]"
      onClick={toggleSidebar}
    >
      {open ? <PanelLeftCloseIcon /> : <PanelLeftOpenIcon />}
    </Button>
  );
}

export function WorkspaceSidebarHeader() {
  return (
    <div
      data-slot="workspace-sidebar-header"
      className="relative flex h-8 shrink-0 items-center bg-sidebar pl-20 [app-region:drag]"
    >
      <Separator className="pointer-events-none absolute inset-x-0 bottom-0 [app-region:no-drag]" />
      <SidebarToggle />
    </div>
  );
}

export function WorkspaceHeader({
  onCloseThread,
  onMoveThread,
  onRenameThread,
  onSelectThread,
  selectedThreadId,
  threads,
}: WorkspaceHeaderProps) {
  const { open } = useSidebar();
  const [draggedThreadId, setDraggedThreadId] = useState<string>();
  const [dragging, setDragging] = useState(false);
  const [dropTarget, setDropTarget] = useState<DropTarget>();
  const [editingThreadId, setEditingThreadId] = useState<string>();
  const drag = useRef<
    { readonly id: string; readonly x: number; readonly y: number } | undefined
  >(undefined);
  const list = useRef<HTMLDivElement>(null);
  const moveThread = useRef(onMoveThread);

  useEffect(() => {
    moveThread.current = onMoveThread;
  }, [onMoveThread]);

  useEffect(() => {
    const targetFor = (clientX: number): DropTarget | undefined =>
      dropTargetFor(
        Array.from(
          list.current?.querySelectorAll<HTMLElement>('[data-thread-tab]') ??
            [],
        ).flatMap((element) => {
          const id = element.dataset.threadTab;
          if (id === undefined) return [];
          const bounds = element.getBoundingClientRect();
          return [{ id, left: bounds.left, width: bounds.width }];
        }),
        clientX,
      );

    const travelled = (event: PointerEvent): boolean =>
      drag.current !== undefined &&
      Math.hypot(
        event.clientX - drag.current.x,
        event.clientY - drag.current.y,
      ) >= dragThreshold;

    const reset = () => {
      drag.current = undefined;
      setDraggedThreadId(undefined);
      setDragging(false);
      setDropTarget(undefined);
    };

    const move = (event: PointerEvent) => {
      if (!travelled(event)) return;
      setDragging(true);
      setDropTarget(targetFor(event.clientX));
    };

    const finish = (event: PointerEvent) => {
      const current = drag.current;
      if (current === undefined) return;
      const target = travelled(event) ? targetFor(event.clientX) : undefined;
      if (target !== undefined) {
        moveThread.current(current.id, target.id, target.position);
      }
      reset();
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', reset);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', reset);
    };
  }, []);

  useEffect(() => {
    if (!dragging) return;
    const { style } = document.body;
    const previous = style.cursor;
    style.cursor = 'grabbing';
    return () => {
      style.cursor = previous;
    };
  }, [dragging]);

  return (
    <header
      data-slot="workspace-header"
      className="relative flex h-8 shrink-0 items-center bg-sidebar [app-region:drag]"
    >
      <Separator className="pointer-events-none absolute inset-x-0 bottom-0 [app-region:no-drag]" />
      {!open && (
        <div className="flex h-full shrink-0 items-center pl-20">
          <SidebarToggle />
        </div>
      )}
      {threads.length > 0 && (
        <Tabs
          value={selectedThreadId ?? ''}
          onValueChange={(id) => {
            const thread = threads.find((candidate) => candidate.id === id);
            if (thread) onSelectThread(thread);
          }}
          className="relative z-10 h-full min-w-0 flex-1 gap-0 overflow-hidden"
        >
          <TabsList
            ref={list}
            aria-label="Open Threads"
            className="no-scrollbar h-full w-full justify-start overflow-x-auto overflow-y-hidden rounded-none bg-transparent p-0"
          >
            {threads.map((thread) => (
              <ThreadTab
                key={thread.id}
                thread={thread}
                active={selectedThreadId === thread.id}
                editing={editingThreadId === thread.id}
                lifted={dragging && draggedThreadId === thread.id}
                dropIndicator={
                  dropTarget !== undefined &&
                  dropTarget.id === thread.id &&
                  dropTarget.id !== draggedThreadId
                    ? dropTarget.position
                    : undefined
                }
                onDragStart={(event) => {
                  drag.current = {
                    id: thread.id,
                    x: event.clientX,
                    y: event.clientY,
                  };
                  setDraggedThreadId(thread.id);
                }}
                onEditStart={() => setEditingThreadId(thread.id)}
                onEditEnd={() =>
                  setEditingThreadId((current) =>
                    current === thread.id ? undefined : current,
                  )
                }
                onRename={(name) => onRenameThread(thread, name)}
                onClose={() => onCloseThread(thread.id)}
              />
            ))}
          </TabsList>
        </Tabs>
      )}
    </header>
  );
}
