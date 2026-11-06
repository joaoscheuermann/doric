// The diagram built-ins as data (openui-diagrams.md F1): Node, Edge, Group
// and Flowchart, their limits and the definer. Imports only zod and the
// `DefineComponent` type; not exported from `src/contracts/index.ts`.

import { z } from 'zod';

import type { DefineComponent } from '../../contracts/builtins.js';

/**
 * Characters (code points) of a label before it is cut, and of an id (at least 1), for every
 * diagram type. Read by `read.ts` (`cutLabel`, `keepUnique`) and by `FLOWCHART_LIMITS`.
 */
export const TEXT_LIMITS = { label: 120, id: 64 } as const;

/** A Flowchart's limits; parts beyond them are cut with a finding (F2). */
export const FLOWCHART_LIMITS = {
  nodes: 100,
  edges: 200,
  groups: 25,
  /** Levels of group nesting; a top-level group is level 1. */
  depth: 4,
  /** Characters (code points) of a label before it is cut. */
  label: TEXT_LIMITS.label,
  /** Characters (code points) of an id, at least 1. */
  id: TEXT_LIMITS.id,
} as const;

export const NODE_SHAPES = [
  'box',
  'round',
  'diamond',
  'circle',
  'cylinder',
] as const;
export type NodeShape = (typeof NODE_SHAPES)[number];

/** `Node(id, label, shape?, group?)`; `shape` defaults to `box`. */
export const flowNodeSchema = z.object({
  id: z.string(),
  label: z.string(),
  shape: z.enum(NODE_SHAPES).optional(),
  group: z.string().optional(),
});

/** `Edge(from, to, label?, line?, arrow?)`; `line` `solid`, `arrow` `end` by default. */
export const flowEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  label: z.string().optional(),
  line: z.enum(['solid', 'dashed']).optional(),
  arrow: z.enum(['end', 'none']).optional(),
});

/** `Group(id, label, parent?)`. */
export const flowGroupSchema = z.object({
  id: z.string(),
  label: z.string(),
  parent: z.string().optional(),
});

/**
 * Node, Edge, Group, then Flowchart with `nodes` of Node refs, `edges` of
 * Edge refs and `groups` of Group refs. Calls `define` exactly four times,
 * in that order, with the names `Node`, `Edge`, `Group`, `Flowchart`, the
 * matching renderer and F1's descriptions; Flowchart's prop keys are, in
 * order, `nodes`, `edges?`, `groups?`, `direction?` (`'down' | 'right'`),
 * `height?` (number). Returns `define`'s results in that order. Never
 * throws by itself.
 */
export const defineDiagramBuiltins = <
  C,
  D extends { readonly ref: z.core.$ZodType },
>(
  define: DefineComponent<C, D>,
  renderers: {
    readonly Node: C;
    readonly Edge: C;
    readonly Group: C;
    readonly Flowchart: C;
  },
): readonly [D, D, D, D] => {
  const node = define({
    name: 'Node',
    props: flowNodeSchema,
    description: 'One box of a Flowchart; group names the Group that holds it.',
    component: renderers.Node,
  });
  const edge = define({
    name: 'Edge',
    props: flowEdgeSchema,
    description: 'A connection between two Node ids.',
    component: renderers.Edge,
  });
  const group = define({
    name: 'Group',
    props: flowGroupSchema,
    description: 'A region of a Flowchart; parent names the Group it sits in.',
    component: renderers.Group,
  });
  const flowchart = define({
    name: 'Flowchart',
    props: z.object({
      nodes: z.array(node.ref),
      edges: z.array(edge.ref).optional(),
      groups: z.array(group.ref).optional(),
      direction: z.enum(['down', 'right']).optional(),
      height: z.number().optional(),
    }),
    description:
      'Boxes and arrows laid out automatically: flowcharts, pipelines, architecture with grouped regions.',
    component: renderers.Flowchart,
  });
  return [node, edge, group, flowchart];
};

/** A SequenceDiagram's limits (UD12); counts only, labels and ids use `TEXT_LIMITS`. */
export const SEQUENCE_LIMITS = {
  participants: 20,
  /** Messages, notes and fragments, depth-first (Terms, step). */
  steps: 200,
} as const;

/** A MindMap's limits (UD12). */
export const MINDMAP_LIMITS = {
  topics: 300,
  /** Levels; the root Topic is level 1. */
  depth: 8,
} as const;

/** An EntityDiagram's limits (UD12); fields and methods are not limited. */
export const ENTITY_LIMITS = {
  entities: 60,
  relations: 120,
} as const;

/** `Message.kind`; `call` when absent or not one of these. */
export const MESSAGE_KINDS = ['call', 'reply', 'async'] as const;
/** `Fragment.kind`; read as `loop` when not one of these. */
export const FRAGMENT_KINDS = ['loop', 'opt', 'alt', 'par'] as const;
/** `Field.key`; unset when absent or not one of these. */
export const FIELD_KEYS = ['pk', 'fk', 'pk-fk', 'unique'] as const;
/** `Relation.kind`; `association` when absent, not one of these, or under `er`. */
export const RELATION_KINDS = [
  'association',
  'inherits',
  'implements',
  'composition',
  'aggregation',
  'dependency',
] as const;
/** `Relation.fromCount` and `toCount`; unset when absent or not one of these. */
export const COUNTS = ['1', '0..1', '*', '1..*'] as const;

/** The diagram components' names. */
export type DiagramType =
  | 'Flowchart'
  | 'SequenceDiagram'
  | 'EntityDiagram'
  | 'MindMap';

/**
 * Each diagram type's part names, read by the check (F15: a part outside its diagram, the
 * DIAGRAMS table) and by `misplaced` (F14). Exactly one entry per `DiagramType`.
 */
export const DIAGRAM_PARTS: Readonly<Record<DiagramType, readonly string[]>> = {
  Flowchart: ['Node', 'Edge', 'Group'],
  SequenceDiagram: ['Participant', 'Message', 'Note', 'Fragment', 'Section'],
  EntityDiagram: ['Entity', 'Field', 'Relation'],
  MindMap: ['Topic'],
};

/**
 * Participant, Message, Note, Section, Fragment, then SequenceDiagram; returns them in that order.
 *
 * Calls `define` exactly six times, in that order. Prop keys, in order (strings unless stated):
 * - `Participant`: `id`, `label`.
 * - `Message`: `from`, `to`, `text`, `kind?` (`z.enum(MESSAGE_KINDS)`).
 * - `Note`: `text`, `over` (`z.array(z.string())`).
 * - `Section`: `label`, `steps` — a zod getter, read after `fragment` is defined (prints
 *   `(Message | Note | Fragment)[]`; never `z.lazy`, which prints `any`).
 * - `Fragment`: `kind` (`z.enum(FRAGMENT_KINDS)`), `sections` (`z.array(section.ref)`).
 * - `SequenceDiagram`: `participants` (`z.array(participant.ref)`), `steps?` (as
 *   `Section.steps`, optional), `height?` (number).
 * Never throws by itself.
 */
export const defineSequenceBuiltins = <
  C,
  D extends { readonly ref: z.core.$ZodType },
>(
  define: DefineComponent<C, D>,
  renderers: {
    readonly Participant: C;
    readonly Message: C;
    readonly Note: C;
    readonly Section: C;
    readonly Fragment: C;
    readonly SequenceDiagram: C;
  },
): readonly [D, D, D, D, D, D] => {
  const participant = define({
    name: 'Participant',
    props: z.object({ id: z.string(), label: z.string() }),
    description: 'One lifeline of a SequenceDiagram.',
    component: renderers.Participant,
  });
  const message = define({
    name: 'Message',
    props: z.object({
      from: z.string(),
      to: z.string(),
      text: z.string(),
      kind: z.enum(MESSAGE_KINDS).optional(),
    }),
    description:
      'One message between two Participant ids; from equal to to is a self-message.',
    component: renderers.Message,
  });
  const note = define({
    name: 'Note',
    props: z.object({ text: z.string(), over: z.array(z.string()) }),
    description: 'A note over one or more Participant ids.',
    component: renderers.Note,
  });
  // `fragment` is defined below; the getter reads it only when the schema is walked.
  const section: D = define({
    name: 'Section',
    props: z.object({
      label: z.string(),
      get steps(): z.ZodArray<
        z.ZodUnion<readonly [D['ref'], D['ref'], D['ref']]>
      > {
        return z.array(z.union([message.ref, note.ref, fragment.ref]));
      },
    }),
    description: 'One labelled run of steps of a Fragment.',
    component: renderers.Section,
  });
  const fragment: D = define({
    name: 'Fragment',
    props: z.object({
      kind: z.enum(FRAGMENT_KINDS),
      sections: z.array(section.ref),
    }),
    description: 'A loop, option, alternative or parallel block of steps.',
    component: renderers.Fragment,
  });
  const diagram = define({
    name: 'SequenceDiagram',
    props: z.object({
      participants: z.array(participant.ref),
      steps: z.array(z.union([message.ref, note.ref, fragment.ref])).optional(),
      height: z.number().optional(),
    }),
    description: 'Messages between participants over time, in steps order.',
    component: renderers.SequenceDiagram,
  });
  return [participant, message, note, section, fragment, diagram];
};

/**
 * Topic, then MindMap.
 *
 * Calls `define` exactly twice. Prop keys, in order:
 * - `Topic`: `label`, `children?` — a zod getter naming the Topic itself (prints `Topic[]`).
 * - `MindMap`: `root` (`topic.ref`, required), `layout?` (`'right' | 'down'`), `height?` (number).
 * Never throws by itself.
 */
export const defineMindMapBuiltins = <
  C,
  D extends { readonly ref: z.core.$ZodType },
>(
  define: DefineComponent<C, D>,
  renderers: { readonly Topic: C; readonly MindMap: C },
): readonly [D, D] => {
  const topic: D = define({
    name: 'Topic',
    props: z.object({
      label: z.string(),
      get children(): z.ZodOptional<z.ZodArray<D['ref']>> {
        return z.array(topic.ref).optional();
      },
    }),
    description: 'One topic of a MindMap and its subtopics.',
    component: renderers.Topic,
  });
  const mindMap = define({
    name: 'MindMap',
    props: z.object({
      root: topic.ref,
      layout: z.enum(['right', 'down']).optional(),
      height: z.number().optional(),
    }),
    description: 'A mind map (right) or a tree (down) from one root Topic.',
    component: renderers.MindMap,
  });
  return [topic, mindMap];
};

/**
 * Field, Entity, Relation, then EntityDiagram.
 *
 * Calls `define` exactly four times, in that order. Prop keys, in order:
 * - `Field`: `name`, `type?`, `key?` (`z.enum(FIELD_KEYS)`).
 * - `Entity`: `id`, `name`, `fields?` (`z.array(field.ref)`), `methods?` (`z.array(z.string())`).
 * - `Relation`: `from`, `to`, `kind?` (`z.enum(RELATION_KINDS)`), `label?`, `fromCount?`
 *   (`z.enum(COUNTS)`), `toCount?` (`z.enum(COUNTS)`).
 * - `EntityDiagram`: `entities` (`z.array(entity.ref)`), `relations?` (`z.array(relation.ref)`),
 *   `notation?` (`'er' | 'class'`), `direction?` (`'down' | 'right'`), `height?` (number).
 * Never throws by itself.
 */
export const defineEntityBuiltins = <
  C,
  D extends { readonly ref: z.core.$ZodType },
>(
  define: DefineComponent<C, D>,
  renderers: {
    readonly Field: C;
    readonly Entity: C;
    readonly Relation: C;
    readonly EntityDiagram: C;
  },
): readonly [D, D, D, D] => {
  const field = define({
    name: 'Field',
    props: z.object({
      name: z.string(),
      type: z.string().optional(),
      key: z.enum(FIELD_KEYS).optional(),
    }),
    description: 'One column or attribute of an Entity.',
    component: renderers.Field,
  });
  const entity = define({
    name: 'Entity',
    props: z.object({
      id: z.string(),
      name: z.string(),
      fields: z.array(field.ref).optional(),
      methods: z.array(z.string()).optional(),
    }),
    description: 'One table or class; methods for classes only.',
    component: renderers.Entity,
  });
  const relation = define({
    name: 'Relation',
    props: z.object({
      from: z.string(),
      to: z.string(),
      kind: z.enum(RELATION_KINDS).optional(),
      label: z.string().optional(),
      fromCount: z.enum(COUNTS).optional(),
      toCount: z.enum(COUNTS).optional(),
    }),
    description:
      'A relation between two Entity ids; kind applies to class diagrams.',
    component: renderers.Relation,
  });
  const diagram = define({
    name: 'EntityDiagram',
    props: z.object({
      entities: z.array(entity.ref),
      relations: z.array(relation.ref).optional(),
      notation: z.enum(['er', 'class']).optional(),
      direction: z.enum(['down', 'right']).optional(),
      height: z.number().optional(),
    }),
    description: 'ER or class diagram laid out automatically.',
    component: renderers.EntityDiagram,
  });
  return [field, entity, relation, diagram];
};
