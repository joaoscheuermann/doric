// Pan and zoom of a diagram area (openui-diagrams.md F8), as papercraft's
// canvas node does in the conversation: the area takes a plain wheel only
// while it is focused, a modifier wheel zooms, and a drag pans. The math is
// `desktop/ui/viewport`'s (F9).

import {
  fitViewport,
  IDENTITY,
  type Viewport,
  wheelGesture,
  ZOOM_STEP,
  zoomAt,
  zoomPercent,
} from 'desktop/ui/viewport';
import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

/** Where a drag started, and the viewport it started from. */
interface Drag {
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
  readonly from: Viewport;
}

/**
 * Pan and zoom of a diagram area (F8). Starts at the fit of `content` in
 * the area, and refits on area resize until the reader pans or zooms. When
 * `interactive`: primary pointerdown focuses the area, Escape blurs it,
 * drag pans, and one non-passive wheel listener follows `wheelGesture`
 * (`zoom: ctrlKey || metaKey`, `captured: document.activeElement === area`),
 * preventing the default only for a gesture. When not interactive: no
 * listeners and the viewport is the fit; turning false returns to the fit.
 * Scale stays within 25–400 %.
 */
export const useDiagramViewport = (
  area: RefObject<HTMLDivElement | null>,
  content: { readonly width: number; readonly height: number },
  interactive: boolean,
): {
  readonly viewport: Viewport;
  /** `zoomPercent(viewport)`. */
  readonly percent: string;
  /** Zoom by ZOOM_STEP (or 1 / ZOOM_STEP) at the area's center. */
  readonly zoomIn: () => void;
  readonly zoomOut: () => void;
  /** Back to the fit; refits on resize again. */
  readonly fit: () => void;
} => {
  const { width, height } = content;
  const [fitted, setFitted] = useState<Viewport>(IDENTITY);
  // The reader's own viewport once they pan or zoom; until then the fit.
  const [own, setOwn] = useState<Viewport | undefined>(undefined);
  const viewport = (interactive ? own : undefined) ?? fitted;
  const current = useRef(viewport);
  current.current = viewport;

  const refit = useCallback(() => {
    const element = area.current;
    if (element === null) return;
    setFitted(
      fitViewport(
        { x: 0, y: 0, width, height },
        { width: element.clientWidth, height: element.clientHeight },
      ) ?? IDENTITY,
    );
  }, [area, width, height]);

  useLayoutEffect(() => {
    refit();
    const element = area.current;
    if (element === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(refit);
    observer.observe(element);
    return () => observer.disconnect();
  }, [area, refit]);

  // A diagram that stops being interactive shows the fit again.
  useEffect(() => {
    if (!interactive) setOwn(undefined);
  }, [interactive]);

  useEffect(() => {
    const element = area.current;
    if (!interactive || element === null) return;
    let drag: Drag | undefined;

    const pointerDown = (event: PointerEvent): void => {
      if (event.button !== 0) return;
      element.focus({ preventScroll: true });
      drag = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        from: current.current,
      };
    };
    const pointerMove = (event: PointerEvent): void => {
      if (drag === undefined || event.pointerId !== drag.pointerId) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (dx === 0 && dy === 0) return;
      const { from } = drag;
      setOwn({ ...from, tx: from.tx + dx, ty: from.ty + dy });
    };
    const pointerUp = (event: PointerEvent): void => {
      if (drag?.pointerId === event.pointerId) drag = undefined;
    };
    const keyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') element.blur();
    };
    const wheel = (event: WheelEvent): void => {
      const gesture = wheelGesture({
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
        zoom: event.ctrlKey || event.metaKey,
        captured: document.activeElement === element,
        pageHeight: element.clientHeight,
      });
      if (gesture === undefined) return;
      event.preventDefault();
      const from = current.current;
      if (gesture.kind === 'zoom') {
        const box = element.getBoundingClientRect();
        setOwn(
          zoomAt(from, gesture.factor, {
            x: event.clientX - box.left,
            y: event.clientY - box.top,
          }),
        );
      } else {
        setOwn({ ...from, tx: from.tx + gesture.dx, ty: from.ty + gesture.dy });
      }
    };

    // A drag goes on while the pointer leaves the area.
    const page = element.ownerDocument;
    element.addEventListener('pointerdown', pointerDown);
    page.addEventListener('pointermove', pointerMove);
    page.addEventListener('pointerup', pointerUp);
    page.addEventListener('pointercancel', pointerUp);
    element.addEventListener('keydown', keyDown);
    element.addEventListener('wheel', wheel, { passive: false });
    return () => {
      element.removeEventListener('pointerdown', pointerDown);
      page.removeEventListener('pointermove', pointerMove);
      page.removeEventListener('pointerup', pointerUp);
      page.removeEventListener('pointercancel', pointerUp);
      element.removeEventListener('keydown', keyDown);
      element.removeEventListener('wheel', wheel);
    };
  }, [area, interactive]);

  const zoomBy = useCallback(
    (factor: number) => {
      const element = area.current;
      setOwn(
        zoomAt(current.current, factor, {
          x: (element?.clientWidth ?? 0) / 2,
          y: (element?.clientHeight ?? 0) / 2,
        }),
      );
    },
    [area],
  );

  return {
    viewport,
    percent: zoomPercent(viewport),
    zoomIn: useCallback(() => zoomBy(ZOOM_STEP), [zoomBy]),
    zoomOut: useCallback(() => zoomBy(1 / ZOOM_STEP), [zoomBy]),
    fit: useCallback(() => setOwn(undefined), []),
  };
};
