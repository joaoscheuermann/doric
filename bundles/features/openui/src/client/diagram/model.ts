// The reading of a Flowchart (openui-diagrams.md F2): one pure function from
// a Flowchart element's props, evaluated by react-lang or as parsed, to the
// parts it draws and the findings the check reports, in F2's step order.

import {
  FLOWCHART_LIMITS,
  NODE_SHAPES,
  type NodeShape,
} from './definitions.js';
import {
  cutLabel,
  isRecord,
  keepUnique,
  type Props,
  partsOf,
  quote,
  text,
} from './read.js';

export interface FlowNode {
  readonly id: string;
  /** Cut to 120 characters; the id when written empty. */
  readonly label: string;
  readonly shape: NodeShape;
  /** The id of a drawn group, if any. */
  readonly group?: string;
}
export interface FlowEdge {
  /** Ids of drawn nodes. */
  readonly from: string;
  readonly to: string;
  /** Cut to 120 characters; absent when written empty or not written. */
  readonly label?: string;
  readonly line: 'solid' | 'dashed';
  readonly arrow: 'end' | 'none';
}
export interface FlowGroup {
  readonly id: string;
  /** Cut to 120 characters; the id when written empty. */
  readonly label: string;
  /** The id of a drawn group, if any. */
  readonly parent?: string;
  /** 1 for a top-level group; at most 4. */
  readonly depth: number;
}
export interface FlowchartModel {
  readonly direction: 'down' | 'right';
  /** Drawn nodes, program order; ids unique. */
  readonly nodes: readonly FlowNode[];
  /** Drawn edges, program order; both ends are drawn nodes. Self-loops and repeats kept. */
  readonly edges: readonly FlowEdge[];
  /** Drawn groups, program order; ids unique, parents form a forest, each holds a node in its subtree. */
  readonly groups: readonly FlowGroup[];
  /**
   * Per type, set only when that type's limit cut parts: how many there were
   * before the cut (the outline's "100 of 130 nodes"). Nodes and groups count
   * valid, unrepeated parts; edges count edges whose two ends are kept nodes.
   */
  readonly cut: {
    readonly nodes?: number;
    readonly edges?: number;
    readonly groups?: number;
  };
  /** F2's finding texts, in step order then program order; each one sentence ending with a period. */
  readonly findings: readonly string[];
}

/** Where a kept group is drawn after step 2. */
interface Placement {
  readonly parent?: string;
  readonly depth: number;
}

/** Step 2: each kept group's parent after unknown parents, loops and depth, with its depth. */
const resolveParents = (
  groups: readonly Props[],
  findings: string[],
): Map<string, Placement> => {
  const ids = new Set(groups.map((group) => group.id as string));
  const parent = new Map<string, string | undefined>();

  for (const group of groups) {
    const id = group.id as string;
    const written = text(group.parent);
    if (written !== undefined && !ids.has(written)) {
      findings.push(
        `Group ${quote(id)} names no Group ${quote(written)} as parent, so it is drawn at the top level.`,
      );
      parent.set(id, undefined);
    } else {
      parent.set(id, written);
    }
  }

  /** `id` is reached again by following parents from it. */
  const onLoop = (id: string): boolean => {
    let at = parent.get(id);
    for (let step = 0; at !== undefined && step < groups.length; step += 1) {
      if (at === id) return true;
      at = parent.get(at);
    }
    return false;
  };
  const looped = [...parent.keys()].filter(onLoop);
  for (const id of looped) {
    findings.push(
      `Group ${quote(id)} is in a parent loop, so it is drawn at the top level.`,
    );
    parent.set(id, undefined);
  }

  // Depths, from the top level down: a group is placed after its parent.
  const written = new Map<string, number>();
  const writtenDepth = (id: string): number => {
    const known = written.get(id);
    if (known !== undefined) return known;
    const above = parent.get(id);
    const depth = above === undefined ? 1 : writtenDepth(above) + 1;
    written.set(id, depth);
    return depth;
  };
  const order = groups.map((group, index) => ({
    id: group.id as string,
    index,
    depth: writtenDepth(group.id as string),
  }));
  const placed = new Map<string, Placement>();
  const moved: { readonly id: string; readonly index: number }[] = [];
  for (const { id, index } of [...order].sort(
    (a, b) => a.depth - b.depth || a.index - b.index,
  )) {
    const above = parent.get(id);
    const depth =
      (above === undefined ? 0 : (placed.get(above)?.depth ?? 0)) + 1;
    if (depth > FLOWCHART_LIMITS.depth) {
      moved.push({ id, index });
      placed.set(id, { depth: 1 });
    } else {
      placed.set(
        id,
        above === undefined ? { depth } : { parent: above, depth },
      );
    }
  }
  for (const { id } of moved.sort((a, b) => a.index - b.index)) {
    findings.push(
      `Group ${quote(id)} nests deeper than 4 levels, so it is drawn at the top level.`,
    );
  }
  return placed;
};

/**
 * The diagram model of a Flowchart element's props, evaluated or as parsed.
 * Pure, total and deterministic: never throws; an entry that is not an
 * element of the matching type with string required props is skipped
 * without a finding; an out-of-schema optional value reads as its default.
 */
export const readFlowchart = (props: unknown): FlowchartModel => {
  const input: Props = isRecord(props) ? props : {};
  const findings: string[] = [];
  const cut: { nodes?: number; edges?: number; groups?: number } = {};

  // 1. Groups.
  const groupStep = keepUnique(
    'Flowchart',
    'Group',
    'groups',
    partsOf(input.groups, 'Group', ['id', 'label']),
    FLOWCHART_LIMITS.groups,
    findings,
  );
  if (groupStep.before !== undefined) cut.groups = groupStep.before;

  // 2. Parents.
  const placed = resolveParents(groupStep.kept, findings);

  // 3. Nodes.
  const nodeStep = keepUnique(
    'Flowchart',
    'Node',
    'nodes',
    partsOf(input.nodes, 'Node', ['id', 'label']),
    FLOWCHART_LIMITS.nodes,
    findings,
  );
  if (nodeStep.before !== undefined) cut.nodes = nodeStep.before;
  const nodeGroups = nodeStep.kept.map((node) => {
    const group = text(node.group);
    if (group === undefined || placed.has(group)) return group;
    findings.push(
      `Node ${quote(node.id as string)} names no Group ${quote(group)}, so it is drawn outside any group.`,
    );
    return undefined;
  });

  // 4. Empty groups.
  const holding = new Set<string>();
  for (const group of nodeGroups) {
    for (let at = group; at !== undefined; at = placed.get(at)?.parent) {
      holding.add(at);
    }
  }
  const groups = groupStep.kept.filter((group) => {
    const id = group.id as string;
    if (holding.has(id)) return true;
    findings.push(`Group ${quote(id)} holds no node, so it is not drawn.`);
    return false;
  });

  // 5. Edges.
  const nodeIds = new Set(nodeStep.kept.map((node) => node.id as string));
  const validEdges = partsOf(input.edges, 'Edge', ['from', 'to']).filter(
    (edge) => {
      const missing = [edge.from as string, edge.to as string].find(
        (end) => !nodeIds.has(end),
      );
      if (missing === undefined) return true;
      findings.push(
        `Edge ${quote(edge.from as string)}→${quote(edge.to as string)} names no Node ${quote(missing)}, so it is not drawn.`,
      );
      return false;
    },
  );
  if (validEdges.length > FLOWCHART_LIMITS.edges) {
    cut.edges = validEdges.length;
    findings.push(
      `The Flowchart has ${validEdges.length} edges, and only the first ${FLOWCHART_LIMITS.edges} are drawn: split the diagram.`,
    );
  }
  const edges = validEdges.slice(0, FLOWCHART_LIMITS.edges);

  // 6. Labels.
  const label = (written: string, name: string): string => {
    const drawn = cutLabel(written);
    if (drawn !== written) {
      findings.push(`The label of ${name} is cut at 120 characters.`);
    }
    return drawn;
  };

  const flowNodes = nodeStep.kept.map((node, i): FlowNode => {
    const id = node.id as string;
    const written = node.label as string;
    const shape = NODE_SHAPES.find((known) => known === node.shape) ?? 'box';
    const group = nodeGroups[i];
    return {
      id,
      label: written === '' ? id : label(written, `Node ${quote(id)}`),
      shape,
      ...(group === undefined ? {} : { group }),
    };
  });
  const flowGroups = groups.map((group): FlowGroup => {
    const id = group.id as string;
    const written = group.label as string;
    const { parent, depth }: Placement = placed.get(id) ?? { depth: 1 };
    return {
      id,
      label: written === '' ? id : label(written, `Group ${quote(id)}`),
      ...(parent === undefined ? {} : { parent }),
      depth,
    };
  });
  const flowEdges = edges.map((edge): FlowEdge => {
    const from = edge.from as string;
    const to = edge.to as string;
    const written = text(edge.label) ?? '';
    return {
      from,
      to,
      ...(written === ''
        ? {}
        : { label: label(written, `Edge ${quote(from)}→${quote(to)}`) }),
      line: edge.line === 'dashed' ? 'dashed' : 'solid',
      arrow: edge.arrow === 'none' ? 'none' : 'end',
    };
  });

  // 7. Empty diagram.
  if (flowNodes.length === 0) findings.push('The Flowchart has no nodes.');

  return {
    direction: input.direction === 'right' ? 'right' : 'down',
    nodes: flowNodes,
    edges: flowEdges,
    groups: flowGroups,
    cut,
    findings,
  };
};
