// Mounts one of the bundle's chat elements the way the chat does: the class
// is defined under a story-only tag, the element gets `services` and a `view`,
// and the reader's choice it dispatches (`chat-block-chosen`) is kept and set
// back on the `view`, so a story's chevron works as the transcript's does.

import type { Services } from 'bundle/contracts';
import type { Chosen } from 'desktop/ui/collapsible-block';
import { useEffect, useMemo, useRef, useState } from 'react';

import { CHAT_BLOCK_CHOSEN_EVENT } from '../../src/client/peers.js';
import { ElementHost } from './element-host.js';

export function ChatViewHost<V extends { readonly chosen: Chosen }>({
  tag,
  element,
  services,
  view,
}: {
  /** A story-only tag, so the story never collides with the window's. */
  readonly tag: `${string}-${string}`;
  readonly element: new () => HTMLElement & { services: Services };
  readonly services: Services;
  /** The `view` the chat would set, `chosen` being the reader's first choice. */
  readonly view: V;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const [chosen, setChosen] = useState<Chosen>(view.chosen);
  useEffect(() => {
    const node = frame.current;
    if (node === null) return;
    const listener = (event: Event) => {
      setChosen(
        (event as CustomEvent<{ readonly chosen: boolean }>).detail.chosen,
      );
    };
    node.addEventListener(CHAT_BLOCK_CHOSEN_EVENT, listener);
    return () => node.removeEventListener(CHAT_BLOCK_CHOSEN_EVENT, listener);
  }, []);
  const properties = useMemo(
    () => ({ view: { ...view, chosen } }),
    [view, chosen],
  );
  return (
    <div ref={frame}>
      <ElementHost
        tag={tag}
        element={element}
        services={services}
        properties={properties}
      />
    </div>
  );
}
