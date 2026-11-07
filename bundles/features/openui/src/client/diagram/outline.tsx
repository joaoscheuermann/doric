// The outline of a diagram (openui-diagrams.md F4, openui-diagrams-phase2.md
// F16): its drawn parts as text, shown while the fence streams and kept for
// screen readers once the picture is drawn.

import { Fragment, type ReactNode } from 'react';

import type { EntityField, EntityModel } from './entity-model.js';
import type { MindMapModel, MindTopic } from './mindmap-model.js';
import type { FlowchartModel } from './model.js';
import type { SeqStep, SequenceModel } from './sequence-model.js';

/** One line of an outline list; `children` render as a nested `<ul>`. `key` unique among siblings. */
export interface OutlineItem {
  readonly key: string;
  readonly text: string;
  readonly children?: readonly OutlineItem[];
}
export interface OutlineList {
  readonly title: string;
  readonly items: readonly OutlineItem[];
}
/** A model's outline as text: the header (also the SVG's `aria-label`) and its lists, in order. */
export interface OutlineText {
  readonly header: string;
  readonly lists: readonly OutlineList[];
}

/** `<n> <singular|plural>`, or `<kept> of <before> <plural>` when a limit cut the type. */
const count = (
  kept: number,
  before: number | undefined,
  singular: string,
  plural: string,
): string => {
  const total = before ?? kept;
  const noun = total === 1 ? singular : plural;
  return before === undefined
    ? `${kept} ${noun}`
    : `${kept} of ${before} ${noun}`;
};

/** Phase 1's header and lists (Nodes, Groups, Connections), texts unchanged. Pure. */
export const flowchartOutline = (model: FlowchartModel): OutlineText => {
  const { nodes, edges, groups, cut } = model;
  const header = `Flowchart: ${[
    count(nodes.length, cut.nodes, 'node', 'nodes'),
    count(edges.length, cut.edges, 'connection', 'connections'),
    ...(groups.length > 0
      ? [count(groups.length, cut.groups, 'group', 'groups')]
      : []),
  ].join(', ')}`;

  const nodeLabel = new Map(nodes.map((node) => [node.id, node.label]));
  const groupLabel = new Map(groups.map((group) => [group.id, group.label]));
  const inside = (group: string | undefined) =>
    group === undefined ? '' : ` (in ${groupLabel.get(group) ?? group})`;

  // Edges may repeat; each keeps its place in the list as its key.
  const connections = edges.map((edge, i) => {
    const arrow = edge.arrow === 'none' ? '—' : '→';
    const line = edge.line === 'dashed' ? ' (dashed)' : '';
    const label = edge.label === undefined ? '' : `: ${edge.label}`;
    return {
      key: `e${i}`,
      text: `${nodeLabel.get(edge.from) ?? edge.from} ${arrow} ${nodeLabel.get(edge.to) ?? edge.to}${line}${label}`,
    };
  });

  return {
    header,
    lists: [
      {
        title: 'Nodes',
        items: nodes.map((node) => ({
          key: node.id,
          text: `${node.label}${inside(node.group)}`,
        })),
      },
      {
        title: 'Groups',
        items: groups.map((group) => ({
          key: group.id,
          text: `${group.label}${inside(group.parent)}`,
        })),
      },
      { title: 'Connections', items: connections },
    ],
  };
};

/** `Sequence diagram: <p> participants, <s> steps`; lists Participants, Steps (F16). Pure. */
export const sequenceOutline = (model: SequenceModel): OutlineText => {
  const { participants, cut } = model;
  const label = new Map(participants.map(({ id, label }) => [id, label]));
  const nameOf = (id: string) => label.get(id) ?? id;
  let steps = 0;
  // Steps have no id; each keeps its place among its siblings as its key.
  const item = (step: SeqStep, i: number): OutlineItem => {
    steps += 1;
    const key = `s${i}`;
    switch (step.type) {
      case 'message': {
        const kind = step.kind === 'call' ? '' : ` (${step.kind})`;
        return {
          key,
          text: `${nameOf(step.from)} → ${nameOf(step.to)}${kind}: ${step.text}`,
        };
      }
      case 'note':
        return {
          key,
          text: `Note over ${step.over.map(nameOf).join(', ')}: ${step.text}`,
        };
      case 'fragment':
        return {
          key,
          text: step.kind,
          children: step.sections.map((section, k) => ({
            key: `c${k}`,
            text: section.label === '' ? step.kind : section.label,
            children: section.steps.map(item),
          })),
        };
    }
  };
  const items = model.steps.map(item);
  return {
    header: `Sequence diagram: ${count(participants.length, cut.participants, 'participant', 'participants')}, ${count(steps, cut.steps, 'step', 'steps')}`,
    lists: [
      {
        title: 'Participants',
        items: participants.map(({ id, label }) => ({ key: id, text: label })),
      },
      { title: 'Steps', items },
    ],
  };
};

/** A field's key as the entity outline writes it after the field. */
const KEY_TEXT: Readonly<Record<NonNullable<EntityField['key']>, string>> = {
  pk: ' (PK)',
  fk: ' (FK)',
  'pk-fk': ' (PK, FK)',
  unique: ' (unique)',
};

/** `ER diagram: <e> entities, <r> relations` or `Class diagram: …`; lists Entities, Relations (F16). Pure. */
export const entityOutline = (model: EntityModel): OutlineText => {
  const { entities, relations, cut } = model;
  const kind = model.notation === 'class' ? 'Class diagram' : 'ER diagram';
  const header = `${kind}: ${count(entities.length, cut.entities, 'entity', 'entities')}, ${count(relations.length, cut.relations, 'relation', 'relations')}`;
  const name = new Map(entities.map((entity) => [entity.id, entity.name]));
  const fieldText = (field: EntityField): string =>
    `${field.name}${field.type === undefined ? '' : `: ${field.type}`}${field.key === undefined ? '' : KEY_TEXT[field.key]}`;

  return {
    header,
    lists: [
      {
        title: 'Entities',
        items: entities.map((entity) => ({
          key: entity.id,
          text: entity.name,
          children: [
            ...entity.fields.map((field, i) => ({
              key: `f${i}`,
              text: fieldText(field),
            })),
            ...entity.methods.map((method, i) => ({
              key: `m${i}`,
              text: method,
            })),
          ],
        })),
      },
      {
        title: 'Relations',
        // Relations may repeat; each keeps its place in the list as its key.
        items: relations.map((relation, i) => {
          const kindText =
            model.notation === 'class' && relation.kind !== 'association'
              ? ` (${relation.kind})`
              : '';
          const counts =
            relation.fromCount === undefined && relation.toCount === undefined
              ? ''
              : ` ${relation.fromCount ?? '?'} to ${relation.toCount ?? '?'}`;
          const label =
            relation.label === undefined ? '' : `: ${relation.label}`;
          return {
            key: `r${i}`,
            text: `${name.get(relation.from) ?? relation.from} → ${name.get(relation.to) ?? relation.to}${kindText}${counts}${label}`,
          };
        }),
      },
    ],
  };
};

/** `Mind map: <t> topics` (`right`) or `Tree: <t> topics` (`down`); one list, Topics, nested. Pure. */
export const mindMapOutline = (model: MindMapModel): OutlineText => {
  // Topics have no id; each keeps its place among its siblings as its key.
  const item = (topic: MindTopic, key: string): OutlineItem => ({
    key,
    text: topic.label,
    children: topic.children.map((child, i) => item(child, `t${i}`)),
  });
  const kind = model.layout === 'down' ? 'Tree' : 'Mind map';
  return {
    header: `${kind}: ${count(model.count, model.cut.topics, 'topic', 'topics')}`,
    lists: [
      {
        title: 'Topics',
        items: model.root === undefined ? [] : [item(model.root, 't0')],
      },
    ],
  };
};

/** `flowchartOutline(model).header`. */
export const outlineHeader = (model: FlowchartModel): string =>
  flowchartOutline(model).header;

/** Items as a `<ul>`, each item's children as a nested `<ul>`. */
function Items(props: {
  readonly items: readonly OutlineItem[];
  readonly labelledBy?: string;
}): ReactNode {
  return (
    <ul aria-labelledby={props.labelledBy} className="list-disc pl-5">
      {props.items.map((item) => (
        <li key={item.key}>
          {item.text}
          {item.children === undefined || item.children.length === 0 ? null : (
            <Items items={item.children} />
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * The text form of a model: the header, then each non-empty list's title and
 * `<ul>` (labelled by the title, children as nested `<ul>`s), then `note`.
 * The root element carries `id`; `hidden` makes it sr-only.
 */
export function Outline(props: {
  readonly text: OutlineText;
  readonly note?: string;
  /** Visually hidden (sr-only) once the picture is drawn. */
  readonly hidden: boolean;
  readonly id: string;
}): ReactNode {
  const { text, note, hidden, id } = props;
  return (
    <div
      id={id}
      className={
        hidden
          ? 'sr-only'
          : 'openui-flowchart-outline max-h-72 overflow-auto rounded-lg border border-border p-3 text-sm'
      }
    >
      <p className="font-medium">{text.header}</p>
      {text.lists.map((list) => {
        if (list.items.length === 0) return null;
        const listId = `${id}-${list.title.toLowerCase()}`;
        return (
          <Fragment key={list.title}>
            <p id={listId} className="mt-1 font-medium">
              {list.title}
            </p>
            <Items items={list.items} labelledBy={listId} />
          </Fragment>
        );
      })}
      {note === undefined ? null : (
        <p className="mt-2 text-xs text-muted-foreground">{note}</p>
      )}
    </div>
  );
}
