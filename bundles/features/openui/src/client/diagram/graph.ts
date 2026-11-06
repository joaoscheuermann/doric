// The layout graph of a diagram model (openui-diagrams.md F6): the drawn
// parts as keyed sizes, so the layout chunk sees no label, id or color.

import type { EntityModel, EntityRelation } from './entity-model.js';
import type { LayoutGraph } from './layout-types.js';
import {
  DIAGRAM_METRICS,
  type EntitySizes,
  type MindMapSizes,
  type Sizes,
} from './measure.js';
import type { MindMapModel, MindTopic } from './mindmap-model.js';
import type { FlowchartModel } from './model.js';

/** Every group's inner padding: the label's line and the group padding on top. */
const GROUP_PADDING = {
  top: DIAGRAM_METRICS.lineHeight + DIAGRAM_METRICS.groupPadding,
  side: DIAGRAM_METRICS.groupPadding,
} as const;

/**
 * The layout graph of a model: node i → `n<i>`, group i → `g<i>`, edge i →
 * `e<i>`, in the model's order, sized from `sizes` (same indices); `group`,
 * `parent`, `from`, `to` hold keys, never the agent's ids; an edge has
 * `label` exactly when `sizes.edges[i]` is defined. `groupPadding` is
 * `{ top: DIAGRAM_METRICS.lineHeight + DIAGRAM_METRICS.groupPadding,
 * side: DIAGRAM_METRICS.groupPadding }`. Pure; never throws for a model from
 * `readFlowchart` with its `sizeModel` sizes.
 */
export const toLayoutGraph = (
  model: FlowchartModel,
  sizes: Sizes,
): LayoutGraph => {
  const nodeKey = new Map(model.nodes.map((node, i) => [node.id, `n${i}`]));
  const groupKey = new Map(model.groups.map((group, i) => [group.id, `g${i}`]));
  const keyOf = (keys: Map<string, string>, id: string | undefined) =>
    id === undefined ? undefined : keys.get(id);

  return {
    direction: model.direction,
    groupPadding: GROUP_PADDING,
    nodes: model.nodes.map((node, i) => {
      const group = keyOf(groupKey, node.group);
      return {
        key: `n${i}`,
        width: sizes.nodes[i]?.width ?? 0,
        height: sizes.nodes[i]?.height ?? 0,
        ...(group === undefined ? {} : { group }),
      };
    }),
    groups: model.groups.map((group, i) => {
      const parent = keyOf(groupKey, group.parent);
      return {
        key: `g${i}`,
        ...(parent === undefined ? {} : { parent }),
        minWidth: sizes.groups[i]?.minWidth ?? 0,
      };
    }),
    edges: model.edges.map((edge, i) => {
      const label = sizes.edges[i];
      return {
        key: `e${i}`,
        from: nodeKey.get(edge.from) ?? '',
        to: nodeKey.get(edge.to) ?? '',
        ...(label === undefined
          ? {}
          : { label: { width: label.width, height: label.height } }),
      };
    }),
  };
};

/**
 * Whether the layout runs `relation` from its `to` (the parent) to its `from` (the child):
 * `inherits` and `implements` under `class`. The drawing reverses such a relation's points.
 */
export const isReversed = (
  model: EntityModel,
  relation: EntityRelation,
): boolean =>
  model.notation === 'class' &&
  (relation.kind === 'inherits' || relation.kind === 'implements');

/**
 * Entity i → `n<i>`, relation i → `e<i>`, `layered`, `markerSpacing`, `transposeRight` under `class`,
 * the model's direction, no groups.
 * Under `class`, an `inherits` or `implements` relation runs from the parent (`to`) to the
 * child (`from`), so parents sit above (`down`) or left of (`right`) their children; the
 * drawing reverses its points. Labels: the relation's label as `label`; under `class`, the
 * counts as `tailLabel` (fromCount) and `headLabel` (toCount), swapped with the ends when reversed.
 *
 * Sizes from `sizes` (same indices): node `width`/`height` from `sizes.entities[i]`; `label`
 * exactly when `sizes.labels[i]` is defined (its `boxWidth` × `boxHeight`); `tailLabel` /
 * `headLabel` exactly when `sizes.tails[i]` / `sizes.heads[i]` are (never under `er`).
 * `groupPadding` as `toLayoutGraph`'s. Pure; never throws for a model from `readEntities` with
 * its `sizeEntities` sizes; the graph always passes the chunk's validation.
 */
export const entityGraph = (
  model: EntityModel,
  sizes: EntitySizes,
): LayoutGraph => {
  const nodeKey = new Map(
    model.entities.map((entity, i) => [entity.id, `n${i}`]),
  );
  const size = (box: { readonly width: number; readonly height: number }) => ({
    width: box.width,
    height: box.height,
  });
  return {
    algorithm: 'layered',
    markerSpacing: true,
    ...(model.notation === 'class' ? { transposeRight: true } : {}),
    direction: model.direction,
    groupPadding: GROUP_PADDING,
    nodes: model.entities.map((_, i) => ({
      key: `n${i}`,
      width: sizes.entities[i]?.width ?? 0,
      height: sizes.entities[i]?.height ?? 0,
    })),
    groups: [],
    edges: model.relations.map((relation, i) => {
      const reversed = isReversed(model, relation);
      const from = nodeKey.get(relation.from) ?? '';
      const to = nodeKey.get(relation.to) ?? '';
      const label = sizes.labels[i];
      const tail = reversed ? sizes.heads[i] : sizes.tails[i];
      const head = reversed ? sizes.tails[i] : sizes.heads[i];
      return {
        key: `e${i}`,
        from: reversed ? to : from,
        to: reversed ? from : to,
        ...(label === undefined
          ? {}
          : { label: { width: label.boxWidth, height: label.boxHeight } }),
        ...(tail === undefined ? {} : { tailLabel: size(tail) }),
        ...(head === undefined ? {} : { headLabel: size(head) }),
      };
    }),
  };
};

/**
 * Topic i in preorder → `n<i>`, edge to each child → `e<i>` (i of the child), `mrtree`,
 * direction from `layout`; node sizes from `sizes.topics[i]`; no groups, no labels, no end
 * labels, no flags; `n0` the root; one tree. A model without a root gives no nodes. Pure;
 * never throws.
 */
export const mindMapGraph = (
  model: MindMapModel,
  sizes: MindMapSizes,
): LayoutGraph => {
  const nodes: LayoutGraph['nodes'][number][] = [];
  const edges: LayoutGraph['edges'][number][] = [];
  const visit = (topic: MindTopic, parent: string | undefined): void => {
    const i = nodes.length;
    const key = `n${i}`;
    nodes.push({
      key,
      width: sizes.topics[i]?.width ?? 0,
      height: sizes.topics[i]?.height ?? 0,
    });
    if (parent !== undefined)
      edges.push({ key: `e${i}`, from: parent, to: key });
    for (const child of topic.children) visit(child, key);
  };
  if (model.root !== undefined) visit(model.root, undefined);
  return {
    algorithm: 'mrtree',
    direction: model.layout,
    groupPadding: GROUP_PADDING,
    nodes,
    groups: [],
    edges,
  };
};
