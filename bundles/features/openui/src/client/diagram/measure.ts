// Measuring and sizing (openui-diagrams.md F5): labels measured in the
// conversation's face once the faces their characters need have loaded,
// wrapped to a width per shape, and boxes sized so the padded label fits
// inside the shape.

import type { NodeShape } from './definitions.js';
import type { EntityModel } from './entity-model.js';
import type { MindMapModel, MindTopic } from './mindmap-model.js';
import type { FlowchartModel } from './model.js';

/** A label as drawn: its lines and the size they take, in px, unpadded. */
export interface TextBlock {
  readonly lines: readonly string[];
  readonly width: number;
  readonly height: number;
}

/** The width in px of one line of text in the diagram font. */
export type Measure = (text: string) => number;

/**
 * The fixed metrics of measuring, sizing and layout (F5), in px; FT17 checks
 * them and `toLayoutGraph` copies the group paddings into the layout graph.
 */
export const DIAGRAM_METRICS: {
  readonly fontSize: number;
  readonly fontWeight: number;
  readonly lineHeight: number;
  /** Padding between a node's label and its shape's inner rectangle. */
  readonly nodePadding: number;
  /** Padding of an edge label's plate. */
  readonly edgeLabelPadding: number;
  /** A group's padding on each side, and below its label line on top. */
  readonly groupPadding: number;
  /** Maximum text width of a label, per shape; diamond and circle smaller than the rest. */
  readonly maxWidth: Readonly<Record<NodeShape | 'edge', number>>;
  /** Px per character where there is no canvas 2D context. */
  readonly estimate: number;
} = {
  fontSize: 13,
  fontWeight: 400,
  lineHeight: 18,
  nodePadding: 10,
  edgeLabelPadding: 4,
  groupPadding: 12,
  maxWidth: {
    box: 160,
    round: 160,
    cylinder: 160,
    diamond: 110,
    circle: 110,
    edge: 140,
  },
  estimate: 7.8,
};

/** The height of a cylinder's elliptic cap; the drawn shape spends three of them. */
export const CYLINDER_CAP = 8;

/** The conversation's face, as `--font-conversation` names it. */
const FALLBACK_FAMILY = "'IBM Plex Mono', monospace";

/** The CSS font of the drawing: weight, size and the conversation's family. */
const diagramFont = (): string => {
  const family =
    typeof document === 'undefined'
      ? ''
      : getComputedStyle(document.documentElement)
          .getPropertyValue('--font-conversation')
          .trim();
  return `${DIAGRAM_METRICS.fontWeight} ${DIAGRAM_METRICS.fontSize}px ${family || FALLBACK_FAMILY}`;
};

/** Characters × `estimate`: the measure where no canvas 2D context exists. */
const estimate: Measure = (text) => [...text].length * DIAGRAM_METRICS.estimate;

/**
 * Loads the faces `text` needs in the diagram font (`--font-conversation`,
 * else `'IBM Plex Mono', monospace`), then measures in it. A rejected font
 * load is ignored; without `document.fonts` the step is skipped; without a
 * canvas 2D context the measure is characters × `estimate`. Never rejects.
 */
export const createMeasure = async (text: string): Promise<Measure> => {
  if (typeof document === 'undefined') return estimate;
  const font = diagramFont();
  const fonts = (document as { fonts?: FontFaceSet }).fonts;
  if (fonts !== undefined) {
    // A face that does not load leaves the faces present to measure.
    await fonts.load(font, text).catch(() => undefined);
  }
  const context = document.createElement('canvas').getContext?.('2d');
  if (context === null || context === undefined) return estimate;
  context.font = font;
  return (line) => context.measureText(line).width;
};

/** `word` cut into lines of at most `maxWidth`, one character at least each. */
const breakWord = (
  word: string,
  maxWidth: number,
  measure: Measure,
): string[] => {
  const lines: string[] = [];
  for (const character of word) {
    const last = lines.at(-1);
    if (last !== undefined && measure(last + character) <= maxWidth) {
      lines[lines.length - 1] = last + character;
    } else {
      lines.push(character);
    }
  }
  return lines;
};

/**
 * `label` wrapped to `maxWidth` on spaces, and inside a word wider than a
 * line. Every line measures ≤ `maxWidth` unless it is one character; `width`
 * is the widest line, `height` lines × line height. `''` gives no lines.
 */
export const wrapLabel = (
  label: string,
  maxWidth: number,
  measure: Measure,
): TextBlock => {
  const lines: string[] = [];
  let current: string | undefined;
  for (const word of label.split(' ').filter((part) => part !== '')) {
    const joined = current === undefined ? word : `${current} ${word}`;
    if (measure(joined) <= maxWidth) {
      current = joined;
      continue;
    }
    if (current !== undefined) lines.push(current);
    const pieces = breakWord(word, maxWidth, measure);
    lines.push(...pieces.slice(0, -1));
    current = pieces.at(-1);
  }
  if (current !== undefined) lines.push(current);
  return {
    lines,
    width: Math.max(0, ...lines.map(measure)),
    height: lines.length * DIAGRAM_METRICS.lineHeight,
  };
};

/** What graph.ts and the drawing take from measuring, in the model's order. */
export interface Sizes {
  /** Box sized so the padded label fits inside the shape (smallest such diamond/circle; cylinder adds caps). */
  readonly nodes: readonly {
    readonly label: TextBlock;
    readonly width: number;
    readonly height: number;
  }[];
  /** Unwrapped label (one line); `minWidth` = label width + both side paddings. */
  readonly groups: readonly {
    readonly label: TextBlock;
    readonly minWidth: number;
  }[];
  /** The padded label box of each edge, if labelled. */
  readonly edges: readonly (
    | {
        readonly label: TextBlock;
        readonly width: number;
        readonly height: number;
      }
    | undefined
  )[];
}

/** The box of `shape` that holds a `width` × `height` padded label. */
const shapeBox = (
  shape: NodeShape,
  width: number,
  height: number,
): { readonly width: number; readonly height: number } => {
  switch (shape) {
    case 'diamond':
      // A centred w × h rectangle fits a W × H diamond when w/W + h/H ≤ 1.
      return { width: 2 * width, height: 2 * height };
    case 'circle': {
      const diameter = Math.hypot(width, height);
      return { width: diameter, height: diameter };
    }
    case 'cylinder':
      // The top cap's lower arc and the bottom cap take three cap heights.
      return { width, height: height + 3 * CYLINDER_CAP };
    default:
      return { width, height };
  }
};

/** A node's label wrapped to its shape's width, and the shape's box around the padded label. */
const sizeNode = (
  text: string,
  shape: NodeShape,
  measure: Measure,
): {
  readonly label: TextBlock;
  readonly width: number;
  readonly height: number;
} => {
  const { nodePadding, maxWidth } = DIAGRAM_METRICS;
  const label = wrapLabel(text, maxWidth[shape], measure);
  return {
    label,
    ...shapeBox(
      shape,
      label.width + 2 * nodePadding,
      label.height + 2 * nodePadding,
    ),
  };
};

/** Sizes of every drawn part of `model`; arrays index-aligned with the model's. Pure given `measure`. */
export const sizeModel = (model: FlowchartModel, measure: Measure): Sizes => {
  const { edgeLabelPadding, groupPadding, lineHeight, maxWidth } =
    DIAGRAM_METRICS;
  return {
    nodes: model.nodes.map((node) => sizeNode(node.label, node.shape, measure)),
    groups: model.groups.map((group) => {
      const width = measure(group.label);
      return {
        label: { lines: [group.label], width, height: lineHeight },
        minWidth: width + 2 * groupPadding,
      };
    }),
    edges: model.edges.map((edge) => {
      if (edge.label === undefined) return undefined;
      const label = wrapLabel(edge.label, maxWidth.edge, measure);
      return {
        label,
        width: label.width + 2 * edgeLabelPadding,
        height: label.height + 2 * edgeLabelPadding,
      };
    }),
  };
};

export interface EntitySizes {
  /** Under `er`, the key column's width, `measure('PK FK ')`, the same for every entity; 0 under `class`. */
  readonly keyColumn: number;
  readonly entities: readonly {
    readonly name: TextBlock;
    /** One line per field (`name type` under `er`, `name: type` under `class`, `name` without a type), then one per method; never wrapped. */
    readonly rows: readonly string[];
    readonly width: number;
    readonly height: number;
  }[];
  /** Padded, as phase 1's edge labels; `undefined` when unlabelled. */
  readonly labels: readonly (
    | (TextBlock & { readonly boxWidth: number; readonly boxHeight: number })
    | undefined
  )[];
  /** Under `class`, the count texts' padded boxes. */
  readonly tails: readonly (
    | { readonly width: number; readonly height: number }
    | undefined
  )[];
  readonly heads: readonly (
    | { readonly width: number; readonly height: number }
    | undefined
  )[];
}

/** The height of a count's end-label box: one line padded by `edgeLabelPadding`, rounded up. */
const COUNT_HEIGHT = 26;

/**
 * Sizes in the model's order (same indices as `model.entities` and `model.relations`):
 * width = widest of `measure(name)`, `keyColumn + measure(row)` per field row and
 * `measure(method)` per method row, plus 2 × `nodePadding`; height = 38 (header band) +
 * 18 per row + `nodePadding`, + `nodePadding` more under `class` with a method. Labels wrapped
 * to `maxWidth.edge`, padded by `edgeLabelPadding`; under `class`, each count
 * `measure(count) + 8` × 26 (`tails[i]` from `fromCount`, `heads[i]` from `toCount`,
 * `undefined` when unset); every `tails`/`heads` entry `undefined` under `er`. Pure.
 */
export const sizeEntities = (
  model: EntityModel,
  measure: Measure,
): EntitySizes => {
  const { nodePadding, lineHeight, edgeLabelPadding, maxWidth } =
    DIAGRAM_METRICS;
  const uml = model.notation === 'class';
  const keyColumn = uml ? 0 : measure('PK FK ');
  const countBox = (count: string | undefined) =>
    !uml || count === undefined
      ? undefined
      : { width: measure(count) + 2 * edgeLabelPadding, height: COUNT_HEIGHT };
  return {
    keyColumn,
    entities: model.entities.map((entity) => {
      const fields = entity.fields.map(({ name, type }) =>
        type === undefined
          ? name
          : uml
            ? `${name}: ${type}`
            : `${name} ${type}`,
      );
      const rows = [...fields, ...entity.methods];
      const nameWidth = measure(entity.name);
      const width = Math.max(
        nameWidth,
        ...fields.map((row) => keyColumn + measure(row)),
        ...entity.methods.map((method) => measure(method)),
      );
      return {
        name: { lines: [entity.name], width: nameWidth, height: lineHeight },
        rows,
        width: width + 2 * nodePadding,
        height:
          lineHeight +
          2 * nodePadding +
          rows.length * lineHeight +
          nodePadding +
          (entity.methods.length > 0 ? nodePadding : 0),
      };
    }),
    labels: model.relations.map((relation) => {
      if (relation.label === undefined) return undefined;
      const label = wrapLabel(relation.label, maxWidth.edge, measure);
      return {
        ...label,
        boxWidth: label.width + 2 * edgeLabelPadding,
        boxHeight: label.height + 2 * edgeLabelPadding,
      };
    }),
    tails: model.relations.map((relation) => countBox(relation.fromCount)),
    heads: model.relations.map((relation) => countBox(relation.toCount)),
  };
};

export interface MindMapSizes {
  /** Preorder; labels wrapped to `maxWidth.round`, padded as nodes. */
  readonly topics: readonly {
    readonly label: TextBlock;
    readonly width: number;
    readonly height: number;
  }[];
}

/** One entry per drawn topic (`model.count`), preorder, each sized as a `round` node; `[]` without a root. Pure. */
export const sizeMindMap = (
  model: MindMapModel,
  measure: Measure,
): MindMapSizes => {
  const preorder = (topic: MindTopic): readonly MindTopic[] => [
    topic,
    ...topic.children.flatMap(preorder),
  ];
  return {
    topics: (model.root === undefined ? [] : preorder(model.root)).map(
      (topic) => sizeNode(topic.label, 'round', measure),
    ),
  };
};
