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

import { Button } from '../components/button.js';
import { ScrollArea, ScrollBar } from '../components/scroll-area.js';
import { TabsList, TabsTrigger } from '../components/tabs.js';
import { Toggle } from '../components/toggle.js';
import { cn } from '../lib/utils.js';
import { useSortableTab, useTabStrip } from './use-tab-strip.js';

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
  onReselect,
  onSelect,
  variant = 'line',
}: {
  readonly items: readonly StripTab[];
  readonly selected?: string;
  readonly label: string;
  readonly onMove: (from: string, to: string) => void;
  readonly onClose?: (id: string) => void;
  /** Activates an already selected view, for example to reopen its panel. */
  readonly onReselect?: (id: string) => void;
  readonly variant?: 'line' | 'default' | 'toggle' | 'project';
  readonly onSelect?: (id: string) => void;
}) {
  const events = useTabStrip(
    items.map((item) => item.id),
    selected,
    onMove,
  );
  const List = variant === 'toggle' ? 'div' : TabsList;
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
        className={cn('min-w-0 flex-1', variant === 'project' && 'h-[28px]')}
      >
        <ScrollArea className="w-full" type="auto">
          <div>
            <List
              {...(variant === 'toggle'
                ? { role: 'group' }
                : { variant: variant === 'project' ? 'default' : variant })}
              aria-label={label}
              className={cn(
                'w-max justify-start',
                variant === 'toggle' && 'flex items-center gap-1',
                variant === 'line' &&
                  'gap-1 p-0 group-data-horizontal/tabs:h-9',
                variant === 'project' &&
                  'gap-[4px] bg-transparent p-0 group-data-horizontal/tabs:h-[28px]',
              )}
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
                    onReselect={onReselect}
                    onSelect={onSelect}
                    toggle={variant === 'toggle'}
                    line={variant === 'line'}
                    project={variant === 'project'}
                  />
                ))}
              </SortableContext>
            </List>
          </div>
          {variant === 'line' && <ScrollBar orientation="horizontal" />}
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
  onReselect,
  onSelect,
  toggle,
  line,
  project,
}: {
  readonly item: StripTab;
  readonly selected?: string;
  readonly events: ReturnType<typeof useTabStrip>;
  readonly onClose?: (id: string) => void;
  readonly onReselect?: (id: string) => void;
  readonly onSelect?: (id: string) => void;
  readonly toggle: boolean;
  readonly line: boolean;
  readonly project: boolean;
}) {
  const sortable = useSortableTab(item.id, events.frozen?.get(item.id));
  const Control = toggle ? Toggle : TabsTrigger;
  const Item = toggle ? 'button' : 'div';
  return (
    <Control
      asChild
      {...(toggle ? { pressed: selected === item.id } : {})}
      value={item.id}
      data-active={selected === item.id ? '' : undefined}
      aria-label={item.ariaLabel ?? item.label}
      aria-keyshortcuts="Space Alt+Shift+ArrowLeft Alt+Shift+ArrowRight"
      aria-describedby={sortable.attributes['aria-describedby']}
      aria-roledescription="sortable tab"
      title={item.title ?? item.label}
      onClick={() => {
        if (toggle && !events.sorting) onSelect?.(item.id);
        if (selected === item.id && !events.sorting) onReselect?.(item.id);
      }}
      onAuxClick={(event) => {
        if (project && event.button === 1 && onClose && !events.sorting) {
          event.preventDefault();
          onClose(item.id);
        }
      }}
      className={cn(
        'group/tab shrink-0 touch-none flex-none select-none motion-reduce:transition-none! motion-reduce:after:transition-none',
        toggle && 'text-xs font-normal',
        line &&
          'h-full after:pointer-events-none group-data-horizontal/tabs:after:bottom-0 data-[state=inactive]:hover:after:opacity-30',
        project &&
          'relative h-[28px] min-w-[100px] max-w-[280px] justify-start gap-[6px] rounded-[6px] border-0 px-[8px] py-0 text-[12px] leading-[16px] font-[500] text-[var(--paper-gray-3)]! hover:bg-[color-mix(in_srgb,currentColor_7.5%,transparent)] hover:text-[var(--paper-gray-2)]! data-active:bg-[var(--paper-control)]! data-active:text-[var(--paper-gray-1)]! data-active:shadow-[var(--paper-shadow-control)]! after:hidden [-webkit-app-region:no-drag] focus-visible:ring-0 focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-[var(--paper-focus)] [&:has(:focus-visible)]:outline-2 [&:has(:focus-visible)]:-outline-offset-1 [&:has(:focus-visible)]:outline-[var(--paper-focus)]',
      )}
    >
      <Item
        {...(toggle ? { type: 'button' as const } : {})}
        ref={sortable.setNodeRef}
        data-tab-id={item.id}
        data-dragging={sortable.isDragging}
        style={sortable.style}
        {...sortable.listeners}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && selected === item.id && !events.sorting)
            onReselect?.(item.id);
          events.keyDown(event, item.id);
          if (!event.defaultPrevented) sortable.listeners?.onKeyDown?.(event);
        }}
      >
        {item.icon}
        {!item.iconOnly && (
          <span
            className={
              project ? 'min-w-0 flex-1 truncate' : 'max-w-40 truncate'
            }
          >
            {item.label}
          </span>
        )}
        {item.badge}
        {onClose && project && (
          <button
            type="button"
            data-slot="tab-close"
            style={sortable.closeStyle}
            className="relative -right-[4px] -ml-[8px] flex size-[28px] shrink-0 items-center justify-center opacity-0 before:absolute before:inset-[4px] before:rounded-[4px] hover:opacity-100! hover:before:bg-[color-mix(in_srgb,currentColor_8%,transparent)] group-hover/tab:opacity-50 group-data-active/tab:opacity-50 focus-visible:opacity-100"
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
            <svg
              aria-hidden="true"
              className="relative size-[8px]!"
              width="8"
              height="8"
              viewBox="0 0 8 8"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
            >
              <path
                d="M0.465332 0.46447L4.00087 4M4.00087 4L7.53641 7.5355M4.00087 4L7.53641 0.46447M4.00087 4L0.465332 7.5355"
                vectorEffect="non-scaling-stroke"
              />
            </svg>
          </button>
        )}
        {onClose && !project && (
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
      </Item>
    </Control>
  );
}
