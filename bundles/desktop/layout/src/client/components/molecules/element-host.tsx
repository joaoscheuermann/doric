import { UiV1 } from 'bundle/contracts';
import { type ErrorInfo, errorFrom } from 'desktop/reads';
import { ErrorNotice } from 'desktop/ui/error-notice';
import { useEffect, useRef, useState } from 'react';

import { layoutErrorCatalog } from '../../domain/error-catalog.js';
import { layoutServices } from '../../services/layout-services.js';

/**
 * Mounts the element `ui/v1` creates for another bundle's item (a panel
 * view, a view's badge) while this host is mounted, and disposes it after.
 * The host is `display: contents`, so the element lays out as the host's
 * parent's child. When `ui.create` throws, a compact, announced notice
 * naming the element takes its place (§7.3).
 */
export function ElementHost({
  tag,
  props,
  className,
}: {
  readonly tag: string;
  readonly props?: Readonly<Record<string, unknown>>;
  readonly className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  latest.current = props;
  /** The creation that failed; it stands only while its tag is the current one. */
  const [failure, setFailure] = useState<{
    readonly tag: string;
    readonly error: ErrorInfo;
  }>();

  useEffect(() => {
    const frame = host.current;
    if (frame === null) return;
    const ui = layoutServices().use(UiV1);
    let element: object;
    try {
      element = ui.create(tag, latest.current);
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
        ui.dispose(element);
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
        catalog={layoutErrorCatalog}
        context={{ Element: tag }}
      />
    );
  }
  return <div ref={host} className={className ?? 'contents'} />;
}
