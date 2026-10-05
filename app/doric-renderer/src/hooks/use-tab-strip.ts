import {
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  type CSSProperties,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from 'react';

type FrozenTab = { readonly width: number; readonly close?: CSSProperties };

/** Keep selection visible and constrain dragging to this tab strip. */
export function useTabStrip(
  ids: readonly string[],
  selected: string | undefined,
  onMove: (from: string, to: string) => void,
) {
  const root = useRef<HTMLDivElement>(null);
  const [frozen, setFrozen] = useState<ReadonlyMap<string, FrozenTab>>();
  const sorting = frozen !== undefined;
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const order = JSON.stringify(ids);

  useEffect(() => {
    if (sorting) return;
    const active = root.current?.querySelector<HTMLElement>(
      '[role="tab"][data-state="active"]',
    );
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selected, order, sorting]);

  return {
    root,
    frozen,
    sorting,
    sensors,
    start: () => {
      const sizes = new Map<string, FrozenTab>();
      for (const tab of Array.from(
        root.current?.querySelectorAll<HTMLElement>('[data-tab-id]') ?? [],
      )) {
        const close = tab.querySelector<HTMLElement>('[data-slot="tab-close"]');
        const style = close && getComputedStyle(close);
        sizes.set(tab.dataset.tabId!, {
          width: tab.getBoundingClientRect().width,
          close:
            close && style
              ? {
                  width: close.getBoundingClientRect().width,
                  marginLeft: style.marginLeft,
                  opacity: style.opacity,
                  transition: 'none',
                }
              : undefined,
        });
      }
      setFrozen(sizes);
    },
    end: ({ active, over }: DragEndEvent) => {
      setFrozen(undefined);
      if (over && active.id !== over.id)
        onMove(String(active.id), String(over.id));
    },
    cancel: () => setFrozen(undefined),
    canScroll: (element: Element) =>
      element ===
      root.current?.querySelector('[data-slot="scroll-area-viewport"]'),
    keyDown: (event: KeyboardEvent, id: string) => {
      if (sorting) {
        // Let dnd-kit's document listener handle these without Radix selecting a tab.
        if (
          [
            'ArrowLeft',
            'ArrowRight',
            'ArrowUp',
            'ArrowDown',
            ' ',
            'Enter',
          ].includes(event.key)
        )
          event.preventDefault();
        return;
      }
      if (
        !event.altKey ||
        !event.shiftKey ||
        !['ArrowLeft', 'ArrowRight'].includes(event.key)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      const target =
        ids[ids.indexOf(id) + (event.key === 'ArrowLeft' ? -1 : 1)];
      if (target !== undefined) onMove(id, target);
    },
  };
}

/** Transform tabs without moving the mounted editor/terminal panels. */
export function useSortableTab(id: string, frozen?: FrozenTab) {
  const sortable = useSortable({
    id,
    transition: { duration: 150, easing: 'ease-out' },
  });
  return {
    ...sortable,
    style: {
      width: frozen?.width,
      transform: CSS.Translate.toString(sortable.transform),
      // An absent inline transition falls back to TabsTrigger's transition-all,
      // making the dragged tab ease toward the pointer on every move.
      transition: sortable.isDragging
        ? 'none'
        : (sortable.transition ?? 'none'),
      zIndex: sortable.isDragging ? 1 : undefined,
    },
    closeStyle: frozen?.close,
  };
}
