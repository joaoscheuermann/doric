import { closestCenter, DndContext } from '@dnd-kit/core';
import {
  restrictToFirstScrollableAncestor,
  restrictToHorizontalAxis,
} from '@dnd-kit/modifiers';
import {
  horizontalListSortingStrategy,
  SortableContext,
} from '@dnd-kit/sortable';
import { XIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useSortableTab, useTabStrip } from '@/hooks/use-tab-strip';
import { cn } from '@/utility/utils';

export type StripTab = {
  readonly id: string;
  readonly label: string;
  readonly ariaLabel?: string;
  readonly title?: string;
  readonly icon: ReactNode;
  readonly badge?: ReactNode;
  readonly iconOnly?: boolean;
};

/** Standard shadcn tabs, with local ordering and overflow shared by all strips. */
export function TabStrip({
  items,
  selected,
  label,
  onMove,
  onClose,
}: {
  readonly items: readonly StripTab[];
  readonly selected?: string;
  readonly label: string;
  readonly onMove: (from: string, to: string) => void;
  readonly onClose?: (id: string) => void;
}) {
  const events = useTabStrip(
    items.map((item) => item.id),
    selected,
    onMove,
  );
  return (
    <DndContext
      sensors={events.sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToHorizontalAxis, restrictToFirstScrollableAncestor]}
      autoScroll={{
        canScroll: events.canScroll,
        threshold: { x: 0.15, y: 0 },
        acceleration: 8,
      }}
      onDragStart={events.start}
      onDragEnd={events.end}
      onDragCancel={events.cancel}
    >
      <div
        ref={events.root}
        data-sorting={events.sorting}
        className="min-w-0 flex-1"
      >
        <ScrollArea className="w-full" type="auto">
          <div>
            <TabsList
              variant="line"
              aria-label={label}
              className="w-max justify-start gap-1 p-0 group-data-horizontal/tabs:h-9"
            >
              <SortableContext
                items={items.map((item) => item.id)}
                strategy={horizontalListSortingStrategy}
              >
                {items.map((item) => (
                  <SortableTab
                    key={item.id}
                    item={item}
                    selected={selected}
                    events={events}
                    onClose={onClose}
                  />
                ))}
              </SortableContext>
            </TabsList>
          </div>
          <ScrollBar orientation="horizontal" />
        </ScrollArea>
      </div>
    </DndContext>
  );
}

function SortableTab({
  item,
  selected,
  events,
  onClose,
}: {
  readonly item: StripTab;
  readonly selected?: string;
  readonly events: ReturnType<typeof useTabStrip>;
  readonly onClose?: (id: string) => void;
}) {
  const sortable = useSortableTab(item.id, events.frozen?.get(item.id));
  return (
    <TabsTrigger
      asChild
      value={item.id}
      data-active={selected === item.id ? '' : undefined}
      aria-label={item.ariaLabel ?? item.label}
      aria-keyshortcuts="Space Alt+Shift+ArrowLeft Alt+Shift+ArrowRight"
      aria-describedby={sortable.attributes['aria-describedby']}
      aria-roledescription="sortable tab"
      title={item.title ?? item.label}
      className="group/tab h-full shrink-0 touch-none flex-none select-none after:pointer-events-none group-data-horizontal/tabs:after:bottom-0 data-[state=inactive]:hover:after:opacity-30 motion-reduce:transition-none! motion-reduce:after:transition-none"
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: this div is the TabsTrigger's own child, so Radix supplies role="tab" and the roving tabIndex at runtime; the handler only forwards the sortable listener's key event */}
      <div
        ref={sortable.setNodeRef}
        data-tab-id={item.id}
        data-dragging={sortable.isDragging}
        style={sortable.style}
        {...sortable.listeners}
        onKeyDown={(event) => {
          events.keyDown(event, item.id);
          if (!event.defaultPrevented) sortable.listeners?.onKeyDown?.(event);
        }}
      >
        {item.icon}
        {!item.iconOnly && (
          <span className="max-w-40 truncate">{item.label}</span>
        )}
        {item.badge}
        {onClose && (
          <span
            data-slot="tab-close"
            style={sortable.closeStyle}
            className={cn(
              'flex w-6 shrink-0 overflow-hidden transition-opacity duration-150 ease-out motion-reduce:transition-none',
              selected === item.id
                ? 'opacity-100'
                : 'pointer-events-none opacity-0 group-hover/tab:pointer-events-auto group-hover/tab:opacity-100',
            )}
          >
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Close ${item.ariaLabel ?? item.label}`}
              tabIndex={selected === item.id ? 0 : -1}
              disabled={events.sorting}
              onPointerDown={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
              onFocus={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onClose(item.id);
              }}
            >
              <XIcon />
            </Button>
          </span>
        )}
      </div>
    </TabsTrigger>
  );
}
