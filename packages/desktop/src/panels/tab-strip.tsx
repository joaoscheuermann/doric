import { Tabs as TabsPrimitive } from '@base-ui/react/tabs';
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
import { TabsList, TabsTrigger } from '../components/tabs.js';
import { Toggle } from '../components/toggle.js';
import { cn } from '../lib/utils.js';
import { useSortableTab, useTabStrip } from './use-tab-strip.js';

/** Shared compact chrome for project and resource tabs. */
export const compactTabClassName =
  'relative flex h-[28px] items-center gap-[6px] rounded-[6px] px-[8px] text-[12px] leading-[16px] font-[500] text-[var(--paper-gray-3)] hover:bg-[color-mix(in_srgb,currentColor_7.5%,transparent)] hover:text-[var(--paper-gray-2)] data-[active=true]:bg-[var(--paper-control)] data-[active=true]:text-[var(--paper-gray-1)] shadow-none data-[active=true]:hover:bg-[var(--paper-control)] [-webkit-app-region:no-drag] [&:has(:focus-visible)]:outline-2 [&:has(:focus-visible)]:-outline-offset-1 [&:has(:focus-visible)]:outline-[var(--paper-focus)]';

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
  const tabs = (
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
        className={cn(
          'min-w-0 flex-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [-webkit-app-region:drag]',
          variant === 'project' && 'h-[28px]',
        )}
      >
        {variant === 'toggle' ? (
          // biome-ignore lint/a11y/useSemanticElements: a row of toggles, not a form's fieldset; the strip had this role under Radix too.
          <div
            role="group"
            aria-label={label}
            className="flex w-max items-center justify-start gap-1"
          >
            {tabs}
          </div>
        ) : (
          <TabsList
            variant={variant === 'project' ? 'default' : variant}
            aria-label={label}
            // Focusing a tab selects it, so arrow keys select as they move.
            activateOnFocus
            onKeyDown={(event) => {
              // A key a tab already handled (a keyboard sort, a move) does not
              // also move focus to another tab.
              if (event.defaultPrevented) event.preventBaseUIHandler();
            }}
            className={cn(
              'w-max justify-start',
              variant === 'line' && 'gap-1 p-0 group-data-horizontal/tabs:h-9',
              variant === 'project' &&
                'gap-[4px] bg-transparent p-0 group-data-horizontal/tabs:h-[28px]',
            )}
          >
            {tabs}
          </TabsList>
        )}
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
  const Control = toggle ? Toggle : project ? TabsPrimitive.Tab : TabsTrigger;
  return (
    <Control
      // A tab is a `div`: the close control inside it is a button of its own.
      {...(toggle
        ? { pressed: selected === item.id }
        : { render: <div />, nativeButton: false })}
      value={item.id}
      ref={sortable.setNodeRef}
      data-tab-id={item.id}
      data-dragging={sortable.isDragging}
      data-active={selected === item.id ? 'true' : undefined}
      aria-label={item.ariaLabel ?? item.label}
      aria-keyshortcuts="Space Alt+Shift+ArrowLeft Alt+Shift+ArrowRight"
      aria-describedby={sortable.attributes['aria-describedby']}
      aria-roledescription="sortable tab"
      title={item.title ?? item.label}
      style={sortable.style}
      {...sortable.listeners}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && selected === item.id && !events.sorting)
          onReselect?.(item.id);
        events.keyDown(event, item.id);
        if (!event.defaultPrevented) sortable.listeners?.onKeyDown?.(event);
        // A key this tab handled (a keyboard sort, a move) is not also a press.
        if (event.defaultPrevented) event.preventBaseUIHandler();
      }}
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
        'group/tab shrink-0 touch-none flex-none select-none [-webkit-app-region:no-drag] motion-reduce:transition-none! motion-reduce:after:transition-none',
        toggle && 'text-xs font-normal',
        line &&
          'h-full after:pointer-events-none group-data-horizontal/tabs:after:bottom-0 not-data-active:hover:after:opacity-30',
        project &&
          cn(
            compactTabClassName,
            'min-w-[100px] max-w-[280px] focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-[var(--paper-focus)]',
          ),
      )}
    >
      {project ? (
        <span className="flex size-[16px] shrink-0 items-center justify-center [&>svg]:size-[16px]">
          {item.icon}
        </span>
      ) : (
        item.icon
      )}
      {!item.iconOnly && (
        <span
          className={project ? 'min-w-0 flex-1 truncate' : 'max-w-40 truncate'}
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
          className={cn(
            'relative -right-[4px] -ml-[8px] flex size-[28px] shrink-0 items-center justify-center before:absolute before:inset-[4px] before:rounded-[4px] hover:opacity-100! hover:before:bg-[color-mix(in_srgb,currentColor_8%,transparent)] group-hover/tab:opacity-50 focus-visible:opacity-100',
            selected === item.id ? 'opacity-50' : 'opacity-0',
          )}
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
    </Control>
  );
}
