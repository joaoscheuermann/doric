// The random-graph generator of the diagrams' measurement method
// (openui-diagrams.md, Test plan): a Flowchart's parts drawn from Park–Miller
// numbers, deterministic in (fixture, seed). The fixtures are generated in the
// tests, not committed.

export interface Fixture {
  readonly nodes: number;
  readonly edges: number;
  readonly groups: number;
  /** Maximum group depth; ignored when `groups` is 0. */
  readonly depth: number;
}

interface Graph {
  readonly groups: readonly {
    readonly id: string;
    readonly label: string;
    readonly parent?: string;
  }[];
  readonly nodes: readonly {
    readonly id: string;
    readonly label: string;
    readonly group?: string;
  }[];
  readonly edges: readonly {
    readonly from: string;
    readonly to: string;
    readonly label?: string;
  }[];
}

/** Park–Miller: the state starts at `seed`; each draw is `state / 2147483647`. */
const random = (seed: number): (() => number) => {
  let state = seed;
  return () => {
    state = (state * 16807) % 2147483647;
    return state / 2147483647;
  };
};

/** The graph of (fixture, seed), drawn in the Test plan's order. */
const generate = (fixture: Fixture, seed: number): Graph => {
  const draw = random(seed);

  const groups: { id: string; label: string; parent?: string }[] = [];
  const depths: number[] = [];
  for (let i = 0; i < fixture.groups; i += 1) {
    let parent: number | undefined;
    if (i > 0 && draw() < 0.5) {
      const candidates = depths.flatMap((depth, index) =>
        depth < fixture.depth ? [index] : [],
      );
      if (candidates.length > 0) {
        parent = candidates[Math.floor(draw() * candidates.length)];
      }
    }
    depths.push(parent === undefined ? 1 : (depths[parent] as number) + 1);
    groups.push({
      id: `g${i}`,
      label: `Region ${i} services`,
      ...(parent === undefined ? {} : { parent: `g${parent}` }),
    });
  }

  const nodeGroups: (number | undefined)[] = [];
  for (let i = 0; i < fixture.nodes; i += 1) {
    nodeGroups.push(
      fixture.groups > 0 && draw() < 0.85
        ? Math.floor(draw() * fixture.groups)
        : undefined,
    );
  }
  const nodes = nodeGroups.map((group, i) => ({
    id: `n${i}`,
    label: `Service ${i}`,
    ...(group === undefined ? {} : { group: `g${group}` }),
  }));

  const edges: { from: string; to: string; label?: string }[] = [];
  const drawn = new Set<string>();
  for (
    let attempt = 0;
    edges.length < fixture.edges && attempt < 100_000;
    attempt += 1
  ) {
    const a = Math.floor(draw() * fixture.nodes);
    const group = nodeGroups[a];
    let b: number;
    if (group !== undefined && draw() < 0.6) {
      const members = nodeGroups.flatMap((candidate, index) =>
        candidate === group ? [index] : [],
      );
      b = members[Math.floor(draw() * members.length)] as number;
    } else {
      b = Math.floor(draw() * fixture.nodes);
    }
    const pair = `${a}>${b}`;
    if (a === b || drawn.has(pair)) continue;
    drawn.add(pair);
    edges.push({
      from: `n${a}`,
      to: `n${b}`,
      ...(draw() < 0.3 ? { label: 'calls' } : {}),
    });
  }

  return { groups, nodes, edges };
};

const element = (typeName: string, props: object) => ({
  type: 'element' as const,
  typeName,
  props,
});

/**
 * A Flowchart's props as lang-core passes them (F2): `{ nodes, edges,
 * groups }` of `{ type: 'element', typeName, props }` nodes, ids `n<i>`,
 * `g<i>`, labels `Service <i>`, `Region <i> services`, edge label `calls`.
 * Deterministic in (fixture, seed): Park–Miller draws in the Test plan's order.
 */
export const randomFlowchart = (fixture: Fixture, seed: number): unknown => {
  const graph = generate(fixture, seed);
  return {
    nodes: graph.nodes.map((node) => element('Node', node)),
    edges: graph.edges.map((edge) => element('Edge', edge)),
    groups: graph.groups.map((group) => element('Group', group)),
  };
};

const text = (value: string): string => JSON.stringify(value);

/** The same graph as an `openui-lang` program in F10's form (root, chart, nodes, groups, edges lines). */
export const randomFlowchartProgram = (
  fixture: Fixture,
  seed: number,
): string => {
  const graph = generate(fixture, seed);
  const nodes = graph.nodes.map((node) =>
    node.group === undefined
      ? `Node(${text(node.id)}, ${text(node.label)})`
      : `Node(${text(node.id)}, ${text(node.label)}, "box", ${text(node.group)})`,
  );
  const groups = graph.groups.map((group) =>
    group.parent === undefined
      ? `Group(${text(group.id)}, ${text(group.label)})`
      : `Group(${text(group.id)}, ${text(group.label)}, ${text(group.parent)})`,
  );
  const edges = graph.edges.map((edge) =>
    edge.label === undefined
      ? `Edge(${text(edge.from)}, ${text(edge.to)})`
      : `Edge(${text(edge.from)}, ${text(edge.to)}, ${text(edge.label)})`,
  );
  return [
    'root = Stack([chart])',
    'chart = Flowchart(nodes, edges, groups, "down")',
    `nodes = [${nodes.join(', ')}]`,
    `groups = [${groups.join(', ')}]`,
    `edges = [${edges.join(', ')}]`,
    '',
  ].join('\n');
};

// Phase 2's generators (openui-diagrams-phase2.md, Test plan, Generators):
// entity diagrams (M9), mind maps (M10) and sequences (M11), with the same
// Park–Miller draws, in the Test plan's order.

const COUNT_VALUES = ['1', '0..1', '*', '1..*'] as const;
const KIND_VALUES = [
  'association',
  'inherits',
  'implements',
  'composition',
  'aggregation',
  'dependency',
] as const;
const FRAGMENT_KIND_VALUES = ['loop', 'opt', 'alt', 'par'] as const;
const TYPES = [
  'text',
  'int',
  'uuid',
  'numeric(12, 2)',
  'timestamp with time zone',
] as const;

interface EntityDraft {
  readonly id: string;
  readonly name: string;
  readonly fields: readonly {
    readonly name: string;
    readonly type: string;
    readonly key?: 'pk';
  }[];
  readonly methods: readonly string[];
}

interface RelationDraft {
  readonly from: string;
  readonly to: string;
  readonly kind?: (typeof KIND_VALUES)[number];
  readonly label?: string;
  readonly fromCount?: (typeof COUNT_VALUES)[number];
  readonly toCount?: (typeof COUNT_VALUES)[number];
}

/** The entity diagram of (shape, seed, notation), drawn in the Test plan's order. */
const generateEntities = (
  shape: { entities: number; relations: number },
  seed: number,
  notation: 'er' | 'class',
): { entities: EntityDraft[]; relations: RelationDraft[] } => {
  const draw = random(seed);
  const entities: EntityDraft[] = [];
  for (let i = 0; i < shape.entities; i += 1) {
    const fieldCount = 1 + Math.floor(draw() * 8);
    const fields: EntityDraft['fields'][number][] = [];
    for (let k = 0; k < fieldCount; k += 1) {
      const name = `f${k}_${'x'.repeat(Math.floor(draw() * 24))}`;
      const type = TYPES[Math.floor(draw() * 5)] as string;
      fields.push(k === 0 ? { name, type, key: 'pk' } : { name, type });
    }
    const methods: string[] = [];
    if (notation === 'class') {
      const methodCount = Math.floor(draw() * 4);
      for (let k = 0; k < methodCount; k += 1) methods.push(`m${k}(): void`);
    }
    entities.push({ id: `e${i}`, name: `Table ${i}`, fields, methods });
  }
  const relations: RelationDraft[] = [];
  const count = () =>
    draw() < 0.2 ? undefined : COUNT_VALUES[Math.floor(draw() * 4)];
  for (let r = 0; r < shape.relations; r += 1) {
    const a = Math.floor(draw() * shape.entities);
    const b = draw() < 0.05 ? a : Math.floor(draw() * shape.entities);
    const label = draw() < 0.3 ? 'refers' : undefined;
    const fromCount = count();
    const toCount = count();
    const kind =
      notation === 'class' ? KIND_VALUES[Math.floor(draw() * 6)] : undefined;
    relations.push({
      from: `e${a}`,
      to: `e${b}`,
      ...(kind === undefined ? {} : { kind }),
      ...(label === undefined ? {} : { label }),
      ...(fromCount === undefined ? {} : { fromCount }),
      ...(toCount === undefined ? {} : { toCount }),
    });
  }
  return { entities, relations };
};

/**
 * An EntityDiagram's props as lang-core passes them (elements `{ type: 'element', typeName,
 * props }`), `{ entities, relations, notation }`, drawn by the Test plan's entity rules (M9):
 * ids `e<i>`, names `Table <i>`, 1–8 fields (`f<k>_` + 0–23 `x`, a type of five, `pk` first),
 * under `class` 0–3 methods `m<k>(): void`; relations with 5 % self-relations, repeats kept,
 * label `refers` at 30 %, counts unset at 20 %, under `class` a random kind. Deterministic in
 * (shape, seed, notation).
 */
export const randomEntityDiagram = (
  shape: { entities: number; relations: number },
  seed: number,
  notation: 'er' | 'class',
): unknown => {
  const drawn = generateEntities(shape, seed, notation);
  return {
    entities: drawn.entities.map((entity) =>
      element('Entity', {
        id: entity.id,
        name: entity.name,
        fields: entity.fields.map((field) => element('Field', field)),
        ...(notation === 'class' ? { methods: entity.methods } : {}),
      }),
    ),
    relations: drawn.relations.map((relation) => element('Relation', relation)),
    notation,
  };
};

interface TopicDraft {
  readonly label: string;
  readonly children: TopicDraft[];
}

/** The tree of (shape, seed): topic 0 the root, topic i under an earlier topic of depth below `depth`. */
const generateMindMap = (
  shape: { topics: number; depth: number },
  seed: number,
): TopicDraft => {
  const draw = random(seed);
  const topics: TopicDraft[] = [{ label: 'Center', children: [] }];
  const depths: number[] = [1];
  for (let i = 1; i < shape.topics; i += 1) {
    const candidates = depths.flatMap((depth, index) =>
      depth < shape.depth ? [index] : [],
    );
    const parent = candidates[Math.floor(draw() * candidates.length)] as number;
    const topic: TopicDraft = { label: `Topic ${i}`, children: [] };
    (topics[parent] as TopicDraft).children.push(topic);
    topics.push(topic);
    depths.push((depths[parent] as number) + 1);
  }
  return topics[0] as TopicDraft;
};

const topicElement = (topic: TopicDraft): unknown =>
  element('Topic', {
    label: topic.label,
    children: topic.children.map(topicElement),
  });

/**
 * A MindMap's props `{ root, layout }` (M10): topic 0 `Center` the root; topic i a child of a
 * uniformly drawn earlier topic of depth below `depth`, labelled `Topic <i>`. Deterministic.
 */
export const randomMindMap = (
  shape: { topics: number; depth: number },
  seed: number,
  layout: 'right' | 'down',
): unknown => ({
  root: topicElement(generateMindMap(shape, seed)),
  layout,
});

type StepDraft =
  | {
      readonly type: 'message';
      readonly from: string;
      readonly to: string;
      readonly text: string;
      readonly kind?: 'reply';
    }
  | { readonly type: 'note'; readonly text: string; readonly over: string[] }
  | {
      readonly type: 'fragment';
      readonly kind: (typeof FRAGMENT_KIND_VALUES)[number];
      readonly sections: {
        readonly label: string;
        readonly steps: StepDraft[];
      }[];
    };

/** The sequence of (shape, seed), drawn round by round as the Test plan says. */
const generateSequence = (
  shape: { participants: number; steps: number },
  seed: number,
): StepDraft[] => {
  const draw = random(seed);
  const p = shape.participants;
  const top: StepDraft[] = [];
  /** Open fragments, innermost last, with their current section's index. */
  const open: {
    fragment: Extract<StepDraft, { type: 'fragment' }>;
    section: number;
  }[] = [];
  let count = 0;
  let notes = 0;
  let messages = 0;
  const target = (): StepDraft[] => {
    const inner = open.at(-1);
    return inner === undefined
      ? top
      : (inner.fragment.sections[inner.section] as { steps: StepDraft[] })
          .steps;
  };
  while (count < shape.steps) {
    const c = draw();
    const inner = open.at(-1);
    if (c < 0.1 && open.length < 3 && shape.steps - count >= 3) {
      const kind = FRAGMENT_KIND_VALUES[Math.floor(draw() * 4)] as
        | 'loop'
        | 'opt'
        | 'alt'
        | 'par';
      const sectionCount = kind === 'alt' || kind === 'par' ? 2 : 1;
      const fragment = {
        type: 'fragment' as const,
        kind,
        sections: Array.from({ length: sectionCount }, (_, k) => ({
          label: `case ${count}.${k}`,
          steps: [] as StepDraft[],
        })),
      };
      target().push(fragment);
      count += 1;
      open.push({ fragment, section: 0 });
    } else if (
      c < 0.2 &&
      inner !== undefined &&
      (inner.fragment.sections[inner.section]?.steps.length ?? 0) > 0
    ) {
      if (inner.section + 1 < inner.fragment.sections.length) {
        inner.section += 1;
      } else {
        open.pop();
      }
    } else if (c < 0.3) {
      const a = Math.floor(draw() * p);
      const over = [`p${a}`];
      if (draw() < 0.5) {
        const b = Math.floor(draw() * p);
        if (b !== a) over.push(`p${b}`);
      }
      target().push({ type: 'note', text: `note ${notes}`, over });
      notes += 1;
      count += 1;
    } else {
      const from = Math.floor(draw() * p);
      const to = Math.floor(draw() * p);
      messages += 1;
      const text =
        messages % 7 === 0
          ? `call ${messages} with a longer payload description that wraps`
          : `call ${messages}`;
      target().push({
        type: 'message',
        from: `p${from}`,
        to: `p${to}`,
        text,
        ...(messages % 3 === 0 ? { kind: 'reply' as const } : {}),
      });
      count += 1;
    }
  }
  return top;
};

const stepElement = (step: StepDraft): unknown => {
  switch (step.type) {
    case 'message':
      return element('Message', {
        from: step.from,
        to: step.to,
        text: step.text,
        ...(step.kind === undefined ? {} : { kind: step.kind }),
      });
    case 'note':
      return element('Note', { text: step.text, over: step.over });
    case 'fragment':
      return element('Fragment', {
        kind: step.kind,
        sections: step.sections.map((section) =>
          element('Section', {
            label: section.label,
            steps: section.steps.map(stepElement),
          }),
        ),
      });
  }
};

/**
 * A SequenceDiagram's props `{ participants, steps }` (M11): participants `p<i>` labelled
 * `Service <i>`; exactly `shape.steps` steps (Terms' count) of messages, notes and fragments by
 * the Test plan's draws, every fragment holding a step. Deterministic in (shape, seed).
 */
export const randomSequence = (
  shape: { participants: number; steps: number },
  seed: number,
): unknown => ({
  participants: Array.from({ length: shape.participants }, (_, i) =>
    element('Participant', { id: `p${i}`, label: `Service ${i}` }),
  ),
  steps: generateSequence(shape, seed).map(stepElement),
});

/** Arguments written positionally; trailing unset ones dropped, inner ones written `null`. */
const args = (values: readonly (string | undefined)[]): string => {
  const last = values.reduce(
    (at, value, i) => (value === undefined ? at : i),
    -1,
  );
  return values
    .slice(0, last + 1)
    .map((value) => (value === undefined ? 'null' : value))
    .join(', ');
};

/** The same diagram as an `openui-lang` program in F22's form: `root = Stack([model])`,
 * `model = EntityDiagram(entities, relations, "<notation>")`, `entities = […]`, `relations = […]`. */
export const randomEntityDiagramProgram = (
  shape: { entities: number; relations: number },
  seed: number,
  notation: 'er' | 'class',
): string => {
  const drawn = generateEntities(shape, seed, notation);
  const entities = drawn.entities.map((entity) => {
    const fields = entity.fields.map(
      (field) =>
        `Field(${args([text(field.name), text(field.type), field.key === undefined ? undefined : text(field.key)])})`,
    );
    const methods =
      notation === 'class' && entity.methods.length > 0
        ? `, [${entity.methods.map(text).join(', ')}]`
        : '';
    return `Entity(${text(entity.id)}, ${text(entity.name)}, [${fields.join(', ')}]${methods})`;
  });
  const relations = drawn.relations.map((relation) => {
    const optional = (value: string | undefined) =>
      value === undefined ? undefined : text(value);
    return `Relation(${args([
      text(relation.from),
      text(relation.to),
      optional(relation.kind),
      optional(relation.label),
      optional(relation.fromCount),
      optional(relation.toCount),
    ])})`;
  });
  return [
    'root = Stack([model])',
    `model = EntityDiagram(entities, relations, ${text(notation)})`,
    `entities = [${entities.join(', ')}]`,
    `relations = [${relations.join(', ')}]`,
    '',
  ].join('\n');
};

const topicCall = (topic: TopicDraft): string =>
  topic.children.length === 0
    ? `Topic(${text(topic.label)})`
    : `Topic(${text(topic.label)}, [${topic.children.map(topicCall).join(', ')}])`;

/** F22's form with branch statements: `root = Stack([map])`, `map = MindMap(top, "<layout>")`,
 * `top = Topic("Center", […])`, then one `b<k> = Topic(…, [Topic(…), …])` per first-level
 * branch (deeper topics inline). */
export const randomMindMapProgram = (
  shape: { topics: number; depth: number },
  seed: number,
  layout: 'right' | 'down',
): string => {
  const root = generateMindMap(shape, seed);
  const branches = root.children.map((_, k) => `b${k + 1}`);
  return [
    'root = Stack([map])',
    `map = MindMap(top, ${text(layout)})`,
    `top = Topic(${text(root.label)}, [${branches.join(', ')}])`,
    ...root.children.map(
      (branch, k) => `${branches[k] as string} = ${topicCall(branch)}`,
    ),
    '',
  ].join('\n');
};

const stepCall = (step: StepDraft): string => {
  switch (step.type) {
    case 'message':
      return `Message(${args([text(step.from), text(step.to), text(step.text), step.kind === undefined ? undefined : text(step.kind)])})`;
    case 'note':
      return `Note(${text(step.text)}, [${step.over.map(text).join(', ')}])`;
    case 'fragment':
      return `Fragment(${text(step.kind)}, [${step.sections
        .map(
          (section) =>
            `Section(${text(section.label)}, [${section.steps.map(stepCall).join(', ')}])`,
        )
        .join(', ')}])`;
  }
};

/** F22's form: `root = Stack([seq])`, `seq = SequenceDiagram(participants, steps)`,
 * `participants = […]`, `steps = […]` (fragments and sections inline). */
export const randomSequenceProgram = (
  shape: { participants: number; steps: number },
  seed: number,
): string => {
  const participants = Array.from(
    { length: shape.participants },
    (_, i) => `Participant(${text(`p${i}`)}, ${text(`Service ${i}`)})`,
  );
  return [
    'root = Stack([seq])',
    'seq = SequenceDiagram(participants, steps)',
    `participants = [${participants.join(', ')}]`,
    `steps = [${generateSequence(shape, seed).map(stepCall).join(', ')}]`,
    '',
  ].join('\n');
};
