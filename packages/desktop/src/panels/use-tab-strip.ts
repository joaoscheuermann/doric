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

  // biome-ignore lint/correctness/useExhaustiveDependencies: order reveals the selection again after reordering
  useEffect(() => {
    if (sorting) return;
    const strip = root.current;
    if (!strip) return;
    const reveal = () => {
      const active = Array.from(
        strip.querySelectorAll<HTMLElement>('[data-tab-id]'),
      ).find((tab) => tab.dataset.tabId === selected);
      active?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [selected, order, sorting]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: order reconnects when the first tab mounts the strip
  useEffect(() => {
    const strip = root.current;
    if (!strip) return;
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || strip.scrollWidth <= strip.clientWidth) return;
      const delta =
        Math.abs(event.deltaX) > Math.abs(event.deltaY)
          ? event.deltaX
          : event.deltaY;
      const unit =
        event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? strip.clientWidth
            : 1;
      strip.scrollLeft += delta * unit;
      event.preventDefault();
    };
    strip.addEventListener('wheel', wheel, { passive: false });
    return () => strip.removeEventListener('wheel', wheel);
  }, [order]);

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
        const tabId = tab.dataset.tabId;
        if (tabId === undefined) continue;
        const close = tab.querySelector<HTMLElement>('[data-slot="tab-close"]');
        const style = close && getComputedStyle(close);
        sizes.set(tabId, {
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
    canScroll: (element: Element) => element === root.current,
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
