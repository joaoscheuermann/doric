// `fit.ts` — centring what the artifact shows. Every revision opens centred:
// the first time its content is measured, the view fits it, and pan and zoom
// after that are the reader's. The canvas changing size relays the artifact
// out: the canvas asks the frame for a fresh scene (outlines, pins and
// hit-tests follow the new layout), and a view nobody moved since it was
// fitted is fitted again — at once, to the scene it has, and again when the
// frame's new scene arrives — so it stays centred.

import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import type { Scene } from './scene.js';
import { visualBounds } from './scene-graph.js';
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
  readonly scene: Scene | undefined;
  readonly viewport: Viewport;
  /** Names the revision on screen: each one is centred once. */
  readonly contentKey: string;
  /** Asks the frame for a fresh scene; it arrives as a new `scene`. */
  readonly requestMeasure: () => void;
  readonly setViewport: (viewport: Viewport) => void;
}

export const useFit = ({
  wrapper,
  scene,
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
   * Centres what the artifact shows — the element, not the page around it —
   * scaled down to fit and never blown up. False while nothing is measurable.
   */
  readonly fitContent: () => boolean;
} => {
  const current = useRef({ scene, viewport });
  current.current = { scene, viewport };

  /** The last view a fit set; while it is still the view, nobody moved it. */
  const autoFit = useRef<Viewport | undefined>(undefined);
  /** The canvas resized under a view nobody moved: the next scene refits. */
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
    (target: Scene | undefined): boolean => {
      if (target === undefined) return false;

      const content = visualBounds(target.graph, target.bounds);
      const size = areaSize();

      if (content === undefined || size.width <= 0 || size.height <= 0)
        return false;

      const fitted = fitViewport(content, size, FIT_MARGIN);

      // Nothing rendered yet: the next scene fits it.
      if (fitted === undefined) return false;

      autoFit.current = fitted;
      setViewport(fitted);

      return true;
    },
    [areaSize, setViewport],
  );

  const fitContent = useCallback(() => {
    refit.current = false;

    return fitTo(current.current.scene);
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
        latest.current.fitTo(current.current.scene);
      }
    });

    observer.observe(element);

    return () => observer.disconnect();
  }, [areaSize, wrapper]);

  const centredFor = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (centredFor.current !== contentKey) {
      refit.current = false;
      if (fitTo(scene)) centredFor.current = contentKey;

      return;
    }

    // The scene the resize asked for: the view nobody moved follows it.
    if (!refit.current || scene === undefined) return;
    if (!latest.current.unmoved()) {
      refit.current = false;

      return;
    }

    fitTo(scene);
  }, [contentKey, fitTo, scene]);

  return { areaSize, area, fitContent };
};
