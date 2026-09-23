import { EditableName } from '@/components/molecules/editable-name';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { useSidebar } from '@/components/ui/sidebar';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  type DropTarget,
  dropTargetFor,
  type Thread,
} from '@/domain/workspace';
import { cn } from '@/utility/utils';
import { PanelLeftCloseIcon, PanelLeftOpenIcon, XIcon } from 'lucide-react';
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
            {threads.map((thread) => {
              const active = selectedThreadId === thread.id;
              const dropped =
                dropTarget?.id === thread.id &&
                dropTarget.id !== draggedThreadId;

              return (
                <div
                  key={thread.id}
                  className={cn(
                    'group/tab relative -ml-px h-full flex-none first:ml-0 [app-region:no-drag]',
                    active && 'z-10',
                    dragging && draggedThreadId === thread.id && 'opacity-60',
                  )}
                >
                  <TabsTrigger asChild value={thread.id}>
                    <div
                      data-thread-tab={thread.id}
                      onPointerDown={(event) => {
                        if (
                          editingThreadId === thread.id ||
                          event.button !== 0
                        ) {
                          return;
                        }
                        drag.current = {
                          id: thread.id,
                          x: event.clientX,
                          y: event.clientY,
                        };
                        setDraggedThreadId(thread.id);
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
                        editing={editingThreadId === thread.id}
                        label="Thread name"
                        value={thread.name}
                        onStart={() => setEditingThreadId(thread.id)}
                        onCancel={() => setEditingThreadId(undefined)}
                        onSubmit={async (name) => {
                          await onRenameThread(thread, name);
                          setEditingThreadId((current) =>
                            current === thread.id ? undefined : current,
                          );
                        }}
                      />
                      {dropped && (
                        <span
                          aria-hidden
                          className={cn(
                            'pointer-events-none absolute inset-y-0 w-0.5 bg-primary',
                            dropTarget.position === 'before'
                              ? 'left-0'
                              : 'right-0',
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
                      setEditingThreadId((current) =>
                        current === thread.id ? undefined : current,
                      );
                      onCloseThread(thread.id);
                    }}
                  >
                    <XIcon className="size-3" />
                  </Button>
                </div>
              );
            })}
          </TabsList>
        </Tabs>
      )}
    </header>
  );
}
