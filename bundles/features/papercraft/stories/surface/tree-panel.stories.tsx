import { type ComponentType, useMemo, useState } from 'react';

import { renderMarkup } from '../../src/client/surface/preview-surface.js';
import {
  buildSceneGraph,
  isolateHiddenIds,
  type SceneGraph,
} from '../../src/client/surface/scene-graph.js';
import { TreePanel } from '../../src/client/surface/tree-panel.js';
import { CanvasArea } from '../support/frame.js';
import { checkoutMarkup } from '../support/preview.js';

/** The tree the canvas derives from the checkout's rendered revision. */
const checkoutGraph = (): SceneGraph => {
  const root = document.createElement('div');
  renderMarkup(root, checkoutMarkup(2));

  return buildSceneGraph(root);
};

/** The id of the pay button in the derived tree, the last node of the card. */
const payButtonOf = (graph: SceneGraph): string | undefined =>
  graph.nodes.find((node) => node.tag === 'button')?.id;

/** The panel with its own selection and layers, as the window keeps them. */
function Tree({
  select,
  hide,
}: {
  readonly select?: (graph: SceneGraph) => string | undefined;
  readonly hide?: (graph: SceneGraph) => ReadonlySet<string>;
}) {
  const graph = useMemo(checkoutGraph, []);
  const [selectedId, setSelectedId] = useState(() => select?.(graph));
  const [hidden, setHidden] = useState<ReadonlySet<string>>(
    () => hide?.(graph) ?? new Set(),
  );

  return (
    <TreePanel
      graph={graph}
      {...(selectedId === undefined ? {} : { selectedId })}
      hidden={hidden}
      onSelect={setSelectedId}
      onToggleHidden={(nodeId) =>
        setHidden((current) => {
          const next = new Set(current);

          if (next.has(nodeId)) next.delete(nodeId);
          else next.add(nodeId);

          return next;
        })
      }
    />
  );
}

export default {
  title: 'Papercraft/Surface/Tree panel',
  component: TreePanel,
  decorators: [
    (Story: ComponentType) => (
      <CanvasArea height={560}>
        <Story />
      </CanvasArea>
    ),
  ],
};

export const Default = {
  render: () => <Tree />,
};

export const Selected = {
  render: () => <Tree select={payButtonOf} />,
};

/** Two layers hidden: struck through, with the closed eye. */
export const HiddenLayers = {
  render: () => (
    <Tree
      hide={(graph) =>
        new Set(
          graph.nodes
            .filter((node) => node.tag === 'p' || node.tag === 'ul')
            .map((node) => node.id),
        )
      }
    />
  ),
};

/** `Isolar` on the pay button: only its chain and its content stay. */
export const Isolated = {
  render: () => (
    <Tree
      select={payButtonOf}
      hide={(graph) => {
        const id = payButtonOf(graph);

        return id === undefined ? new Set() : isolateHiddenIds(graph, id);
      }}
    />
  ),
};

/** Before the revision rendered: no tree yet. */
export const Empty = {
  render: () => (
    <TreePanel
      graph={undefined}
      hidden={new Set()}
      onSelect={() => undefined}
      onToggleHidden={() => undefined}
    />
  ),
};
