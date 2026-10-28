// `tree-panel.tsx` — the derived tree of the window's canvas (spec: "A janela
// do canvas"), over the same `scene-graph` the pointer uses.
//
// Clicking a row selects; the selected row is highlighted, and the selection
// lights the element in the canvas. Each row also hides its node: layers are
// view state, exploration, never a durable decision.

import { Button } from 'desktop/ui/button';
import { cn } from 'desktop/ui/utils';
import { EyeIcon, EyeOffIcon } from 'lucide-react';
import { memo } from 'react';

import {
  nodeLabel,
  type SceneGraph,
  type SceneNode,
  stampLabel,
} from './scene-graph.js';

// Memoised: the tree draws up to the derivation's limit of rows, and only a
// new derivation, the selection or the layers change it — never a pan or a
// zoom of the canvas beside it.
export const TreePanel = memo(function TreePanel({
  graph,
  selectedId,
  hidden,
  onSelect,
  onToggleHidden,
}: {
  readonly graph: SceneGraph | undefined;
  readonly selectedId?: string;
  readonly hidden: ReadonlySet<string>;
  readonly onSelect: (nodeId: string) => void;
  readonly onToggleHidden: (nodeId: string) => void;
}) {
  return (
    <aside
      className="papercraft-tree absolute top-(--doric-titlebar-height) bottom-24 left-0 z-10 w-56 overflow-auto border-r border-border bg-background/80 backdrop-blur"
      aria-label="estrutura"
    >
      <div className="px-2 py-1.5 text-[10px] font-normal tracking-wide text-muted-foreground uppercase">
        estrutura
      </div>
      {(graph?.nodes ?? []).map((node: SceneNode) => (
        <div
          key={node.id}
          data-node-id={node.id}
          data-selected={String(selectedId === node.id)}
          data-hidden={String(hidden.has(node.id))}
          className={cn(
            'flex items-center gap-1 py-0.5 pr-1 font-mono text-xs hover:bg-muted',
            node.depth > 0 &&
              `papercraft-tree-indent papercraft-tree-depth-${String(Math.min(node.depth, 8))}`,
            selectedId === node.id ? 'bg-muted' : undefined,
            hidden.has(node.id)
              ? 'text-muted-foreground line-through'
              : undefined,
          )}
        >
          <button
            type="button"
            className="min-w-0 flex-1 truncate text-left"
            title={stampLabel(node) ?? nodeLabel(node)}
            onClick={() => onSelect(node.id)}
          >
            {nodeLabel(node)}
          </button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={hidden.has(node.id) ? 'mostrar' : 'esconder'}
            onClick={() => onToggleHidden(node.id)}
          >
            {hidden.has(node.id) ? (
              <EyeOffIcon aria-hidden="true" />
            ) : (
              <EyeIcon aria-hidden="true" />
            )}
          </Button>
        </div>
      ))}
    </aside>
  );
});
