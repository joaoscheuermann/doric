// FT11 (openui-diagrams.md F2): `readFlowchart` reads a Flowchart element's
// props, as lang-core passes them, into the drawn parts and the findings. One
// case per rule of F2: the parts kept, and the exact finding texts in order.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  type FlowchartModel,
  readFlowchart,
} from '../../src/client/diagram/model.js';

const element = (typeName: string, props: Record<string, unknown>) => ({
  type: 'element',
  typeName,
  props,
});

const Node = (id: string, label: string, shape?: string, group?: string) =>
  element('Node', {
    id,
    label,
    ...(shape === undefined ? {} : { shape }),
    ...(group === undefined ? {} : { group }),
  });

const Edge = (
  from: string,
  to: string,
  label?: string,
  line?: string,
  arrow?: string,
) =>
  element('Edge', {
    from,
    to,
    ...(label === undefined ? {} : { label }),
    ...(line === undefined ? {} : { line }),
    ...(arrow === undefined ? {} : { arrow }),
  });

const Group = (id: string, label: string, parent?: string) =>
  element('Group', { id, label, ...(parent === undefined ? {} : { parent }) });

const read = (props: {
  readonly nodes?: unknown;
  readonly edges?: unknown;
  readonly groups?: unknown;
  readonly direction?: unknown;
}): FlowchartModel => readFlowchart(props);

const ids = (parts: readonly { readonly id: string }[]): string[] =>
  parts.map((part) => part.id);

/** `count` nodes `n0`… with no group. */
const manyNodes = (count: number) =>
  Array.from({ length: count }, (_, i) => Node(`n${i}`, `Node ${i}`));

test('a part with defaults draws as a box, solid, with an arrow, top-down, without findings', () => {
  const model = read({
    nodes: [Node('a', 'A'), Node('b', 'B')],
    edges: [Edge('a', 'b')],
  });

  assert.deepEqual(model.findings, []);
  assert.equal(model.direction, 'down');
  assert.deepEqual(model.nodes, [
    { id: 'a', label: 'A', shape: 'box' },
    { id: 'b', label: 'B', shape: 'box' },
  ]);
  assert.deepEqual(model.edges, [
    { from: 'a', to: 'b', line: 'solid', arrow: 'end' },
  ]);
  assert.deepEqual(model.groups, []);
  assert.deepEqual(model.cut, {});
});

test('direction is read as written', () => {
  const model = read({
    nodes: [Node('a', 'A')],
    direction: 'right',
  });

  assert.equal(model.direction, 'right');
});

test('an id of 0 or of 65 characters is not drawn; 64 characters is', () => {
  const long = 'a'.repeat(65);
  const max = 'b'.repeat(64);
  const model = read({
    nodes: [Node('', 'Empty'), Node(long, 'Long'), Node(max, 'Max')],
    groups: [Group('', 'Empty group'), Group('g'.repeat(65), 'Long group')],
  });

  assert.deepEqual(ids(model.nodes), [max]);
  assert.deepEqual(model.groups, []);
  assert.deepEqual(model.findings, [
    'Group "" is not drawn because an id has 1 to 64 characters.',
    'Group "ggggggggggggggggggggggg…" is not drawn because an id has 1 to 64 characters.',
    'Node "" is not drawn because an id has 1 to 64 characters.',
    'Node "aaaaaaaaaaaaaaaaaaaaaaa…" is not drawn because an id has 1 to 64 characters.',
  ]);
});

test('a repeated node id and group id: only the first is drawn', () => {
  const model = read({
    nodes: [
      Node('api', 'API', 'box', 'core'),
      Node('api', 'Other API'),
      Node('db', 'DB'),
    ],
    groups: [Group('core', 'Core'), Group('core', 'Core again')],
  });

  assert.deepEqual(model.nodes, [
    { id: 'api', label: 'API', shape: 'box', group: 'core' },
    { id: 'db', label: 'DB', shape: 'box' },
  ]);
  assert.deepEqual(model.groups, [{ id: 'core', label: 'Core', depth: 1 }]);
  assert.deepEqual(model.findings, [
    'Group "core" appears twice, and only the first is drawn.',
    'Node "api" appears twice, and only the first is drawn.',
  ]);
});

test('an id longer than 24 characters is written as its first 23 and …, escaped after shortening', () => {
  const thirty = 'abcdefghijklmnopqrstuvwxyz0123';
  // Shortened first: 22 q's and the quote, then `…`; escaped, the quote
  // takes two characters. Escaping first would cut the backslash off.
  const quoted = `${'q'.repeat(22)}"${'r'.repeat(7)}`;
  const model = read({
    nodes: [
      Node(thirty, 'Thirty', 'box', 'missing'),
      Node(quoted, 'Quoted', 'box', 'missing'),
    ],
  });

  assert.deepEqual(model.findings, [
    'Node "abcdefghijklmnopqrstuvw…" names no Group "missing", so it is drawn outside any group.',
    `Node "${'q'.repeat(22)}\\"…" names no Group "missing", so it is drawn outside any group.`,
  ]);
  assert.deepEqual(ids(model.nodes), [thirty, quoted]);
});

test('101 nodes: the first 100 are drawn and cut counts 101', () => {
  const model = read({ nodes: manyNodes(101) });

  assert.equal(model.nodes.length, 100);
  assert.equal(model.nodes.at(-1)?.id, 'n99');
  assert.deepEqual(model.cut, { nodes: 101 });
  assert.deepEqual(model.findings, [
    'The Flowchart has 101 nodes, and only the first 100 are drawn: split the diagram.',
  ]);
});

test('100 nodes are all drawn, and cut stays empty', () => {
  const model = read({ nodes: manyNodes(100) });

  assert.equal(model.nodes.length, 100);
  assert.deepEqual(model.cut, {});
  assert.deepEqual(model.findings, []);
});

test('the node count of cut leaves out nodes with an invalid or repeated id', () => {
  const model = read({
    nodes: [Node('', 'Empty'), Node('n0', 'Again'), ...manyNodes(101)],
  });

  assert.equal(model.nodes.length, 100);
  assert.deepEqual(model.cut, { nodes: 101 });
});

test('201 edges: the first 200 are drawn; an edge dropped for a missing end is not counted', () => {
  const edges = [
    Edge('a', 'missing'),
    ...Array.from({ length: 201 }, () => Edge('a', 'b')),
  ];
  const model = read({ nodes: [Node('a', 'A'), Node('b', 'B')], edges });

  assert.equal(model.edges.length, 200);
  assert.deepEqual(model.cut, { edges: 201 });
  assert.deepEqual(model.findings, [
    'Edge "a"→"missing" names no Node "missing", so it is not drawn.',
    'The Flowchart has 201 edges, and only the first 200 are drawn: split the diagram.',
  ]);
});

test('26 groups: the first 25 are drawn and cut counts 26', () => {
  const groups = Array.from({ length: 26 }, (_, i) => Group(`g${i}`, `G${i}`));
  const nodes = Array.from({ length: 25 }, (_, i) =>
    Node(`n${i}`, `N${i}`, 'box', `g${i}`),
  );
  const model = read({ nodes, groups });

  assert.deepEqual(
    ids(model.groups),
    Array.from({ length: 25 }, (_, i) => `g${i}`),
  );
  assert.deepEqual(model.cut, { groups: 26 });
  assert.deepEqual(model.findings, [
    'The Flowchart has 26 groups, and only the first 25 are drawn: split the diagram.',
  ]);
});

test('a parent that names no group: the group is drawn at the top level', () => {
  const model = read({
    nodes: [Node('n', 'N', 'box', 'a')],
    groups: [Group('a', 'A', 'nope')],
  });

  assert.deepEqual(model.groups, [{ id: 'a', label: 'A', depth: 1 }]);
  assert.deepEqual(model.findings, [
    'Group "a" names no Group "nope" as parent, so it is drawn at the top level.',
  ]);
});

test('a two-group parent loop: both are drawn at the top level', () => {
  const model = read({
    nodes: [Node('n1', 'N1', 'box', 'a'), Node('n2', 'N2', 'box', 'b')],
    groups: [Group('a', 'A', 'b'), Group('b', 'B', 'a')],
  });

  assert.deepEqual(model.groups, [
    { id: 'a', label: 'A', depth: 1 },
    { id: 'b', label: 'B', depth: 1 },
  ]);
  assert.deepEqual(model.findings, [
    'Group "a" is in a parent loop, so it is drawn at the top level.',
    'Group "b" is in a parent loop, so it is drawn at the top level.',
  ]);
});

test('a group naming itself as parent is a loop of one', () => {
  const model = read({
    nodes: [Node('n', 'N', 'box', 'a')],
    groups: [Group('a', 'A', 'a')],
  });

  assert.deepEqual(model.groups, [{ id: 'a', label: 'A', depth: 1 }]);
  assert.deepEqual(model.findings, [
    'Group "a" is in a parent loop, so it is drawn at the top level.',
  ]);
});

test('a child written before its parent keeps its parent', () => {
  const model = read({
    nodes: [Node('n', 'N', 'box', 'child')],
    groups: [Group('child', 'Child', 'parent'), Group('parent', 'Parent')],
  });

  assert.deepEqual(model.groups, [
    { id: 'child', label: 'Child', parent: 'parent', depth: 2 },
    { id: 'parent', label: 'Parent', depth: 1 },
  ]);
  assert.deepEqual(model.findings, []);
});

/** A chain g1 ⊃ g2 ⊃ … ⊃ g<length>, with a node in each group. */
const chain = (length: number) => ({
  groups: Array.from({ length }, (_, i) =>
    Group(`g${i + 1}`, `G${i + 1}`, i === 0 ? undefined : `g${i}`),
  ),
  nodes: Array.from({ length }, (_, i) =>
    Node(`n${i + 1}`, `N${i + 1}`, 'box', `g${i + 1}`),
  ),
});

test('five nested groups: the fifth is drawn at the top level', () => {
  const model = read(chain(5));

  assert.deepEqual(
    model.groups.map(({ id, parent, depth }) => ({ id, parent, depth })),
    [
      { id: 'g1', parent: undefined, depth: 1 },
      { id: 'g2', parent: 'g1', depth: 2 },
      { id: 'g3', parent: 'g2', depth: 3 },
      { id: 'g4', parent: 'g3', depth: 4 },
      { id: 'g5', parent: undefined, depth: 1 },
    ],
  );
  assert.deepEqual(model.findings, [
    'Group "g5" nests deeper than 4 levels, so it is drawn at the top level.',
  ]);
});

test('a chain of six: the fifth moves to the top level and takes the sixth with it', () => {
  const model = read(chain(6));

  assert.deepEqual(
    model.groups.map(({ id, parent, depth }) => ({ id, parent, depth })),
    [
      { id: 'g1', parent: undefined, depth: 1 },
      { id: 'g2', parent: 'g1', depth: 2 },
      { id: 'g3', parent: 'g2', depth: 3 },
      { id: 'g4', parent: 'g3', depth: 4 },
      { id: 'g5', parent: undefined, depth: 1 },
      { id: 'g6', parent: 'g5', depth: 2 },
    ],
  );
  assert.deepEqual(model.findings, [
    'Group "g5" nests deeper than 4 levels, so it is drawn at the top level.',
  ]);
});

test('a node in an unknown group is drawn outside any group', () => {
  const model = read({ nodes: [Node('n', 'N', 'box', 'zz')] });

  assert.deepEqual(model.nodes, [{ id: 'n', label: 'N', shape: 'box' }]);
  assert.deepEqual(model.findings, [
    'Node "n" names no Group "zz", so it is drawn outside any group.',
  ]);
});

test('a group with no node is not drawn, and its empty child neither, each with its finding', () => {
  const model = read({
    nodes: [Node('n', 'N')],
    groups: [Group('outer', 'Outer'), Group('inner', 'Inner', 'outer')],
  });

  assert.deepEqual(model.groups, []);
  assert.deepEqual(model.findings, [
    'Group "outer" holds no node, so it is not drawn.',
    'Group "inner" holds no node, so it is not drawn.',
  ]);
});

test('a group whose node sits in a child group is drawn', () => {
  const model = read({
    nodes: [Node('n', 'N', 'box', 'inner')],
    groups: [Group('outer', 'Outer'), Group('inner', 'Inner', 'outer')],
  });

  assert.deepEqual(ids(model.groups), ['outer', 'inner']);
  assert.deepEqual(model.findings, []);
});

test('an edge to an unknown node is not drawn; the first missing end is named', () => {
  const model = read({
    nodes: [Node('a', 'A')],
    edges: [Edge('a', 'zz'), Edge('yy', 'zz')],
  });

  assert.deepEqual(model.edges, []);
  assert.deepEqual(model.findings, [
    'Edge "a"→"zz" names no Node "zz", so it is not drawn.',
    'Edge "yy"→"zz" names no Node "yy", so it is not drawn.',
  ]);
});

test('a label of 121 characters is cut to 119 and …; one of 120 is not', () => {
  const long = 'x'.repeat(121);
  const model = read({
    nodes: [Node('a', long, 'box', 'g'), Node('b', 'y'.repeat(120))],
    groups: [Group('g', long)],
    edges: [Edge('a', 'b', long)],
  });

  const cut = `${'x'.repeat(119)}…`;
  assert.equal(model.nodes[0]?.label, cut);
  assert.equal(model.nodes[1]?.label, 'y'.repeat(120));
  assert.equal(model.groups[0]?.label, cut);
  assert.equal(model.edges[0]?.label, cut);
  // F2 orders findings by step, then parts in program order; it does not
  // order the three part types within step 6, so only the set is asserted.
  assert.deepEqual(
    [...model.findings].sort(),
    [
      'The label of Node "a" is cut at 120 characters.',
      'The label of Group "g" is cut at 120 characters.',
      'The label of Edge "a"→"b" is cut at 120 characters.',
    ].sort(),
  );
});

test('a label of 61 emoji is 61 characters and is not cut', () => {
  const emoji = '😀'.repeat(61);
  assert.equal(emoji.length, 122);
  const model = read({ nodes: [Node('a', emoji)] });

  assert.equal(model.nodes[0]?.label, emoji);
  assert.deepEqual(model.findings, []);
});

test('a label of 121 emoji is cut without splitting a surrogate pair', () => {
  const model = read({ nodes: [Node('a', '😀'.repeat(121))] });

  assert.equal(model.nodes[0]?.label, `${'😀'.repeat(119)}…`);
  assert.deepEqual(model.findings, [
    'The label of Node "a" is cut at 120 characters.',
  ]);
});

test('an empty label: a node or group draws its id, an edge draws no label', () => {
  const model = read({
    nodes: [Node('a', '', 'box', 'g'), Node('b', 'B')],
    groups: [Group('g', '')],
    edges: [Edge('a', 'b', '')],
  });

  assert.equal(model.nodes[0]?.label, 'a');
  assert.equal(model.groups[0]?.label, 'g');
  assert.equal(model.edges.length, 1);
  assert.equal(model.edges[0]?.label, undefined);
  assert.equal('label' in (model.edges[0] ?? {}), false);
  assert.deepEqual(model.findings, []);
});

test('no nodes: the Flowchart has no nodes', () => {
  assert.deepEqual(read({ nodes: [] }).findings, [
    'The Flowchart has no nodes.',
  ]);
  assert.deepEqual(read({ nodes: [Node('', 'Empty')] }).findings, [
    'Node "" is not drawn because an id has 1 to 64 characters.',
    'The Flowchart has no nodes.',
  ]);
});

test('a self-loop and a repeated edge are drawn without a finding', () => {
  const model = read({
    nodes: [Node('a', 'A'), Node('b', 'B')],
    edges: [Edge('a', 'a'), Edge('a', 'b'), Edge('a', 'b')],
  });

  assert.deepEqual(
    model.edges.map(({ from, to }) => `${from}>${to}`),
    ['a>a', 'a>b', 'a>b'],
  );
  assert.deepEqual(model.findings, []);
});

test('an optional value outside its schema reads as its default, without a finding', () => {
  const model = read({
    nodes: [Node('a', 'A', 'hexagon'), Node('b', 'B', 'diamond')],
    edges: [Edge('a', 'b', 'x', 'wavy', 'both')],
    direction: 'sideways',
  });

  assert.deepEqual(
    model.nodes.map((node) => node.shape),
    ['box', 'diamond'],
  );
  assert.equal(model.edges[0]?.line, 'solid');
  assert.equal(model.edges[0]?.arrow, 'end');
  assert.equal(model.direction, 'down');
  assert.deepEqual(model.findings, []);
});

test('an entry that is not an element of its type with string required props is skipped without a finding', () => {
  const model = read({
    nodes: [
      'a',
      null,
      42,
      { type: 'element', typeName: 'Edge', props: { from: 'a', to: 'b' } },
      { type: 'element', typeName: 'Node', props: { id: 7, label: 'Seven' } },
      { type: 'element', typeName: 'Node' },
      { typeName: 'Node', props: { id: 'x', label: 'X' } },
      Node('ok', 'OK'),
    ],
    edges: [Node('ok', 'Not an edge'), { from: 'ok', to: 'ok' }],
    groups: [Edge('ok', 'ok')],
  });

  assert.deepEqual(ids(model.nodes), ['ok']);
  assert.deepEqual(model.edges, []);
  assert.deepEqual(model.groups, []);
  assert.deepEqual(model.findings, []);
});

test('edges: null (still streaming) gives no edges and no finding', () => {
  const model = read({ nodes: [Node('a', 'A')], edges: null, groups: null });

  assert.deepEqual(model.edges, []);
  assert.deepEqual(model.groups, []);
  assert.deepEqual(model.findings, []);
});

test('reading never throws, whatever the props', () => {
  for (const props of [undefined, null, 'x', 1, [], { nodes: 'x' }]) {
    assert.doesNotThrow(() => readFlowchart(props));
  }
});
