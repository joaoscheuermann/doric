import type { RegionEntry, Regions, Ui } from 'bundle/contracts';
import {
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import { ErrorNotice } from './error-notice.js';
import {
  type ErrorCatalog,
  type ErrorInfo,
  errorFrom,
} from './reads/errors.js';

/** The entry of the one code `ElementHost` defines (§2.2). */
const elementHostCatalog: ErrorCatalog = {
  element_failed: { title: 'View failed to open', retryable: false },
};

/**
 * Mounts the element `ui` creates for `tag` while mounted and disposes it
 * after; a failed creation draws a compact notice.
 *
 * It draws another bundle's item (a panel view, a view's badge). The host is
 * `display: contents`, so the element lays out as the host's parent's child.
 * When `ui.create` throws, a compact, announced notice naming the element
 * takes its place (§7.3).
 */
export function ElementHost({
  ui,
  tag,
  props,
  className,
}: {
  /** The caller's `ui/v1`. */
  readonly ui: Ui;
  readonly tag: string;
  readonly props?: Readonly<Record<string, unknown>>;
  readonly className?: string;
}): ReactElement {
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  latest.current = props;
  /** The element is created again only when `tag` changes, not when `ui` is a new object. */
  const latestUi = useRef(ui);
  latestUi.current = ui;
  /** The creation that failed; it stands only while its tag is the current one. */
  const [failure, setFailure] = useState<{
    readonly tag: string;
    readonly error: ErrorInfo;
  }>();

  useEffect(() => {
    const frame = host.current;
    if (frame === null) return;
    const elements = latestUi.current;
    let element: object;
    try {
      element = elements.create(tag, latest.current);
    } catch (error) {
      console.error(`Doric: the element <${tag}> could not be created:`, error);
      setFailure({
        tag,
        error: errorFrom(
          'element_failed',
          `The element <${tag}> could not be created.`,
          error,
        ),
      });
      return;
    }
    frame.replaceChildren(element as Node);
    return () => {
      frame.replaceChildren();
      try {
        elements.dispose(element);
      } catch {
        // An element already disposed needs nothing more.
      }
    };
  }, [tag]);

  if (failure?.tag === tag) {
    return (
      <ErrorNotice
        variant="compact"
        announce
        error={failure.error}
        catalog={elementHostCatalog}
        context={{ Element: tag }}
      />
    );
  }
  return <div ref={host} className={className ?? 'contents'} />;
}

const none: readonly RegionEntry[] = Object.freeze([]);

/**
 * A region's items as `regions` sorts them; the same array until the region
 * changes. For the surfaces that draw their own frame around each item (a
 * panel's tab strip).
 */
export const useRegionItems = (
  regions: Regions,
  region: string,
): readonly RegionEntry[] => {
  const subscribe = useCallback(
    (listener: () => void) => {
      const subscription = regions.subscribe(region, listener);
      return () => subscription.dispose();
    },
    [regions, region],
  );
  return useSyncExternalStore(
    subscribe,
    () => regions.items(region),
    () => none,
  );
};
