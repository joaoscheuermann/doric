import { UiV1 } from 'bundle/contracts';
import { useEffect, useRef } from 'react';

import { layoutServices } from '../../services/layout-services.js';

/**
 * Mounts the element `ui/v1` creates for another bundle's item (a panel
 * view, a view's badge) while this host is mounted, and disposes it after.
 * The host is `display: contents`, so the element lays out as the host's
 * parent's child.
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

  useEffect(() => {
    const frame = host.current;
    if (frame === null) return;
    const ui = layoutServices().use(UiV1);
    let element: object;
    try {
      element = ui.create(tag, latest.current);
    } catch (error) {
      console.error(`Doric: the element <${tag}> could not be created:`, error);
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

  return <div ref={host} className={className ?? 'contents'} />;
}
