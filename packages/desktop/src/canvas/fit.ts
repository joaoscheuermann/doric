// `fit.ts` — centring what the artifact shows. Every revision opens centred:
// the first time its content is measured, the view fits it, and pan and zoom
// after that are the reader's. The canvas changing size relays the artifact
// out: the canvas asks the owner for a fresh measurement (outlines, pins and
// hit-tests follow the new layout), and a view nobody moved since it was
// fitted is fitted again — at once, to the content it has, and again when the
// owner's new measurement arrives — so it stays centred.

import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import type { ContentBounds } from './geometry.js';
import { fitViewport, type Viewport } from './viewport.js';

/** The room a fit leaves around the element, clear of the header and footer. */
const FIT_MARGIN = 48;

/** The canvas's size, in surface pixels. */
export interface AreaSize {
  readonly width: number;
  readonly height: number;
}

export interface FitInput {
  readonly wrapper: RefObject<HTMLDivElement | null>;
  /**
   * What the owner wants framed, in content coordinates; undefined while
   * nothing is measurable. A new object means a new measurement: keep it
   * referentially stable between measurements (memoise it on its source).
   */
  readonly content: ContentBounds | undefined;
  readonly viewport: Viewport;
  /** Names what is on screen (a revision): each one is centred once. */
  readonly contentKey: string;
  /** Asks the owner for a fresh measurement; it arrives as a new `content`. */
  readonly requestMeasure: () => void;
  readonly setViewport: (viewport: Viewport) => void;
}

/**
 * Centres each `contentKey` once, the first time its `content` fits (margin
 * 48). When the canvas resizes it calls `requestMeasure`; a view nobody moved
 * since its fit is fitted again at once and again on the next `content`. Pan
 * and zoom after that are the reader's.
 */
export const useFit = ({
  wrapper,
  content,
  viewport,
  contentKey,
  requestMeasure,
  setViewport,
}: FitInput): {
  /** The canvas's size now, read from the element. */
  readonly areaSize: () => AreaSize;
  /** The canvas's size as last observed, for what renders by it. */
  readonly area: AreaSize;
  /**
   * Centres `content`, scaled down to fit and never blown up. False while
   * nothing is measurable (no content, no area, or content without area).
   */
  readonly fitContent: () => boolean;
} => {
  const current = useRef({ content, viewport });
  current.current = { content, viewport };

  /** The last view a fit set; while it is still the view, nobody moved it. */
  const autoFit = useRef<Viewport | undefined>(undefined);
  /** The canvas resized under a view nobody moved: the next content refits. */
  const refit = useRef(false);

  const areaSize = useCallback((): AreaSize => {
    const element = wrapper.current;

    return {
      width: element?.clientWidth ?? 0,
      height: element?.clientHeight ?? 0,
    };
  }, [wrapper]);

  const [area, setArea] = useState<AreaSize>({ width: 0, height: 0 });

  const fitTo = useCallback(
    (target: ContentBounds | undefined): boolean => {
      const size = areaSize();

      if (target === undefined || size.width <= 0 || size.height <= 0)
        return false;

      const fitted = fitViewport(target, size, FIT_MARGIN);

      // Nothing rendered yet: the next content fits it.
      if (fitted === undefined) return false;

      autoFit.current = fitted;
      setViewport(fitted);

      return true;
    },
    [areaSize, setViewport],
  );

  const fitContent = useCallback(() => {
    refit.current = false;

    return fitTo(current.current.content);
  }, [fitTo]);

  const unmoved = (): boolean =>
    autoFit.current !== undefined &&
    current.current.viewport === autoFit.current;

  const latest = useRef({ fitTo, requestMeasure, unmoved });
  latest.current = { fitTo, requestMeasure, unmoved };

  useLayoutEffect(() => {
    setArea(areaSize());
  }, [areaSize]);

  useEffect(() => {
    const element = wrapper.current;

    if (element === null || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(() => {
      const next = areaSize();

      setArea((known) =>
        known.width === next.width && known.height === next.height
          ? known
          : next,
      );
      latest.current.requestMeasure();

      if (latest.current.unmoved()) {
        refit.current = true;
        latest.current.fitTo(current.current.content);
      }
    });

    observer.observe(element);

    return () => observer.disconnect();
  }, [areaSize, wrapper]);

  const centredFor = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (centredFor.current !== contentKey) {
      refit.current = false;
      if (fitTo(content)) centredFor.current = contentKey;

      return;
    }

    // The measurement the resize asked for: the view nobody moved follows it.
    if (!refit.current || content === undefined) return;
    if (!latest.current.unmoved()) {
      refit.current = false;

      return;
    }

    fitTo(content);
  }, [content, contentKey, fitTo]);

  return { areaSize, area, fitContent };
};
