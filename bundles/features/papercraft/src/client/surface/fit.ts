// `fit.ts` — centring what the artifact shows. Every revision opens centred:
// the first time its content is measured, the view fits it, and pan and zoom
// after that are the reader's. The canvas changing size relays the artifact
// out: the cached bounds are measured again (outlines, pins and hit-tests
// follow the new layout), and a view nobody moved since it was fitted is
// fitted again, so it stays centred.

import { type RefObject, useCallback, useEffect, useRef } from 'react';

import type { Scene } from './scene.js';
import { visualBounds } from './scene-graph.js';
import { fitViewport, type Viewport } from './viewport.js';

/** The room a fit leaves around the element, clear of the header and footer. */
const FIT_MARGIN = 48;

export interface FitInput {
  readonly wrapper: RefObject<HTMLDivElement | null>;
  readonly scene: Scene | undefined;
  readonly viewport: Viewport;
  /** Names the revision on screen: each one is centred once. */
  readonly contentKey: string;
  /** Measures the scene again, answering the new one at once. */
  readonly remeasure: () => Scene | undefined;
  readonly setViewport: (viewport: Viewport) => void;
}

export const useFit = ({
  wrapper,
  scene,
  viewport,
  contentKey,
  remeasure,
  setViewport,
}: FitInput): {
  /** The canvas's size, in surface pixels. */
  readonly areaSize: () => { readonly width: number; readonly height: number };
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

  const areaSize = useCallback(() => {
    const area = wrapper.current;

    return {
      width: area?.clientWidth ?? 0,
      height: area?.clientHeight ?? 0,
    };
  }, [wrapper]);

  const fitTo = useCallback(
    (target: Scene | undefined): boolean => {
      if (target === undefined) return false;

      const content = visualBounds(target.graph, target.bounds);
      const area = areaSize();

      if (content === undefined || area.width <= 0 || area.height <= 0)
        return false;

      const fitted = fitViewport(content, area, FIT_MARGIN);

      // Nothing rendered yet: the next derivation fits it.
      if (fitted === undefined) return false;

      autoFit.current = fitted;
      setViewport(fitted);

      return true;
    },
    [areaSize, setViewport],
  );

  const fitContent = useCallback(() => fitTo(current.current.scene), [fitTo]);

  useEffect(() => {
    const area = wrapper.current;

    if (area === null || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(() => {
      const next = remeasure();

      if (next === undefined) return;

      if (
        autoFit.current !== undefined &&
        current.current.viewport === autoFit.current
      ) {
        fitTo(next);
      }
    });

    observer.observe(area);

    return () => observer.disconnect();
  }, [fitTo, remeasure, wrapper]);

  const centredFor = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (centredFor.current === contentKey) return;
    if (fitTo(scene)) centredFor.current = contentKey;
  }, [contentKey, fitTo, scene]);

  return { areaSize, fitContent };
};
