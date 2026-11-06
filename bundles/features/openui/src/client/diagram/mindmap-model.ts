// The reading of a MindMap (openui-diagrams-phase2.md F14): one pure function
// from a MindMap element's props to the topics it draws and the findings the
// check reports, in F14's order.

import { MINDMAP_LIMITS } from './definitions.js';
import {
  cutLabel,
  isElement,
  isRecord,
  length,
  type Props,
  partsOf,
} from './read.js';

/** One drawn topic. */
export interface MindTopic {
  /** Cut at 120 characters; `''` when written empty (drawn as an empty box). */
  readonly label: string;
  /** 1 for the root. */
  readonly depth: number;
  /** Drawn subtopics, program order; every child has `depth + 1` ≤ 8. */
  readonly children: readonly MindTopic[];
}
export interface MindMapModel {
  /** `right` when absent or not `right`/`down`. */
  readonly layout: 'right' | 'down';
  /** As written when a number, else absent. */
  readonly height?: number;
  /** Absent when `root` is not a Topic element with a string label. */
  readonly root?: MindTopic;
  /** The number of drawn topics. */
  readonly count: number;
  readonly cut: { readonly topics?: number };
  readonly findings: readonly string[];
}

/** A label shortened past 24 characters, as `quote` shortens ids. */
const shorten = (label: string): string =>
  length(label) > 24 ? `${[...label].slice(0, 23).join('')}…` : label;

/** A topic path as a finding writes it: each label shortened, joined by ` › `, quoted once. */
const pathOf = (labels: readonly string[]): string =>
  JSON.stringify(labels.map(shorten).join(' › '));

/** A topic's label as written (a string, by `partsOf` or the root's check). */
const labelOf = (topic: Props): string => topic.label as string;

/** A topic's written subtopics: its `children` that are Topics with a string label. */
const childrenOf = (topic: Props): readonly Props[] =>
  partsOf(topic.children, 'Topic', ['label']);

/** The root's props when it is a Topic element with a string label. */
const rootOf = (input: Props): Props | undefined =>
  isElement(input.root) &&
  input.root.typeName === 'Topic' &&
  typeof input.root.props.label === 'string'
    ? input.root.props
    : undefined;

/**
 * Reads a MindMap element's props (any value). Findings, in order (F14): topics deeper
 * than 8 levels (preorder), the 300-topic limit, cut labels of drawn topics, and an empty
 * map. `<path>` is the topic path, quoted once. Entries of `children` that are not Topic
 * elements with a string `label` are skipped with their subtopics, without a finding.
 * Pure; never throws.
 */
export const readMindMap = (props: unknown): MindMapModel => {
  const input: Props = isRecord(props) ? props : {};
  const height = input.height;
  const base = {
    layout: input.layout === 'down' ? 'down' : 'right',
    ...(typeof height === 'number' && Number.isFinite(height)
      ? { height }
      : {}),
  } as const;
  const root = rootOf(input);
  if (root === undefined) {
    return {
      ...base,
      count: 0,
      cut: {},
      findings: ['The MindMap has no topics.'],
    };
  }

  // 1. Depth: count the topics within 8 levels; a deeper one gives a finding.
  const findings: string[] = [];
  const within = (topic: Props, path: readonly string[]): number => {
    const here = [...path, labelOf(topic)];
    if (here.length > MINDMAP_LIMITS.depth) {
      findings.push(
        `Topic ${pathOf(here)} is deeper than ${MINDMAP_LIMITS.depth} levels, so it and its subtopics are not drawn.`,
      );
      return 0;
    }
    return childrenOf(topic).reduce(
      (sum, child) => sum + within(child, here),
      1,
    );
  };
  const total = within(root, []);

  // 2. Count: topics kept in preorder up to the limit.
  const over = total > MINDMAP_LIMITS.topics;
  if (over) {
    findings.push(
      `The MindMap has ${total} topics, and only the first ${MINDMAP_LIMITS.topics} are drawn: split the diagram.`,
    );
  }

  // 3. Labels, of the drawn topics in preorder.
  let count = 0;
  const keep = (topic: Props, path: readonly string[]): MindTopic => {
    count += 1;
    const here = [...path, labelOf(topic)];
    const label = cutLabel(labelOf(topic));
    if (label !== labelOf(topic)) {
      findings.push(
        `The label of Topic ${pathOf(here)} is cut at 120 characters.`,
      );
    }
    const children: MindTopic[] = [];
    for (const child of childrenOf(topic)) {
      if (here.length >= MINDMAP_LIMITS.depth) break;
      if (count >= MINDMAP_LIMITS.topics) break;
      children.push(keep(child, here));
    }
    return { label, depth: here.length, children };
  };
  const drawn = keep(root, []);

  return {
    ...base,
    root: drawn,
    count,
    cut: over ? { topics: total } : {},
    findings,
  };
};
