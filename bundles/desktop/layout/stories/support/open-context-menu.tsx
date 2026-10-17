// Opens the context menu wrapped around its child once it mounts, the way a
// right-click does, so a story shows the menu without a pointer. The context
// menu anchors itself to the pointer only from the trigger's `contextmenu`
// event; opening it through the root's `open` prop would pin it to the
// viewport's corner.

import { type ReactNode, useEffect, useRef } from 'react';

export function OpenContextMenu({
  children,
}: {
  readonly children: ReactNode;
}) {
  const frame = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const trigger = frame.current?.firstElementChild;
    if (!(trigger instanceof HTMLElement)) return;
    const box = trigger.getBoundingClientRect();
    trigger.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: box.left + 24,
        clientY: box.bottom - 4,
      }),
    );
  }, []);

  return (
    <div ref={frame} className="contents">
      {children}
    </div>
  );
}
