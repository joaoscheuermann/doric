import { cn } from '@/lib/utils';
import { type FocusEvent, type ReactNode } from 'react';

import type { CaretEdge, ProseNode } from './editing';

/**
 * One prose node. Every node keeps its one renderer for its whole life, because
 * the caret walks from node to node and a node that mounted on demand would
 * change how its text looks on the way in. A node below a dirty edit renders
 * dimmed. A comment renders inside the surface, under the block it is about.
 */
export function TurnNode({
  node,
  focused,
  dimmed,
  onFocus,
  onBlur,
  children,
}: {
  readonly node: ProseNode;
  readonly focused: boolean;
  readonly dimmed: boolean;
  readonly onFocus: (edge?: CaretEdge) => void;
  readonly onBlur: () => void;
  /** The node's surface, mounted for the node's whole life. */
  readonly children: ReactNode;
}) {
  const blur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    // Focus moving to another node (or staying inside this one) is not a close.
    if (next instanceof HTMLElement && next.closest('[data-node]') !== null) {
      return;
    }
    onBlur();
  };

  return (
    <div
      className={cn('min-w-0', dimmed && 'opacity-70')}
      data-node={node.id}
      tabIndex={0}
      onClick={() => {
        // A node is always mounted, so a click is what opens it for editing or
        // commenting. It must not move the caret: the browser's own click
        // position and any selection the gesture produced have to stand.
        if (!focused) onFocus();
      }}
      onBlur={blur}
      onFocus={() => onFocus()}
    >
      {children}
    </div>
  );
}
