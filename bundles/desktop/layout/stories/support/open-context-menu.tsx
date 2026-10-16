// Opens the context menu wrapped around its child once it mounts, the way a
// right-click does, so a story shows the menu without a pointer. Radix's
// context menu has no `open` prop; it opens from the trigger's
// `contextmenu` event at the pointer's position.

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
