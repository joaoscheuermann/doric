// FT20 (openui-diagrams-phase2.md F14): `readMindMap` reads a MindMap
// element's props, as lang-core passes them, into the drawn topics and the
// findings. One case per rule of F14: the topics kept, and the exact finding
// texts in order.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  type MindMapModel,
  type MindTopic,
  readMindMap,
} from '../../src/client/diagram/mindmap-model.js';

const element = (typeName: string, props: Record<string, unknown>) => ({
  type: 'element',
  typeName,
  props,
});

const Topic = (label: unknown, children?: readonly unknown[]) =>
  element('Topic', {
    label,
    ...(children === undefined ? {} : { children }),
  });

/** `count` leaf topics labelled `<prefix><i>`, i from 1. */
const leaves = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, i) => Topic(`${prefix}${i + 1}`));

/** A chain of topics labelled `labels`, each the only child of the one before. */
const chain = (labels: readonly string[]): unknown => {
  const [first, ...rest] = labels;
  return Topic(first, rest.length === 0 ? [] : [chain(rest)]);
};

const read = (props: unknown): MindMapModel => readMindMap(props);

/** Labels in preorder. */
const preorder = (topic: MindTopic | undefined): string[] =>
  topic === undefined
    ? []
    : [topic.label, ...topic.children.flatMap((child) => preorder(child))];

const LEVELS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];

test('a map of three levels reads every topic with its depth, right by default, without findings', () => {
  const model = read({
    root: Topic('Launch', [Topic('Marketing', [Topic('Ads')]), Topic('Sales')]),
  });

  assert.deepEqual(model.findings, []);
  assert.equal(model.layout, 'right');
  assert.equal(model.count, 4);
  assert.equal(model.cut.topics, undefined);
  assert.deepEqual(model.root, {
    label: 'Launch',
    depth: 1,
    children: [
      {
        label: 'Marketing',
        depth: 2,
        children: [{ label: 'Ads', depth: 3, children: [] }],
      },
      { label: 'Sales', depth: 2, children: [] },
    ],
  });
});

test('a topic at level 9 is not drawn with its subtopics, one finding with its path', () => {
  const model = read({ root: chain(LEVELS) });

  assert.deepEqual(model.findings, [
    'Topic "A › B › C › D › E › F › G › H › I" is deeper than 8 levels, so it and its subtopics are not drawn.',
  ]);
  assert.equal(model.count, 8);
  assert.deepEqual(preorder(model.root), LEVELS.slice(0, 8));
});

test('301 topics within 8 levels: the first 300 in preorder are kept, cut.topics is 301', () => {
  // 1 root + A with 200 subtopics + B with 98: 301 topics; preorder keeps B and 97 of its subtopics.
  const model = read({
    root: Topic('Root', [
      Topic('A', leaves('a', 200)),
      Topic('B', leaves('b', 98)),
    ]),
  });

  assert.deepEqual(model.findings, [
    'The MindMap has 301 topics, and only the first 300 are drawn: split the diagram.',
  ]);
  assert.equal(model.cut.topics, 301);
  assert.equal(model.count, 300);
  const [a, b] = model.root?.children ?? [];
  assert.equal(a?.children.length, 200);
  assert.equal(b?.label, 'B');
  assert.equal(b?.children.length, 97);
  assert.equal(b?.children.at(-1)?.label, 'b97');
});

test('a 121-character label is cut at 120 characters, with its path in the finding', () => {
  const long = 'x'.repeat(121);
  const model = read({ root: Topic('Root', [Topic(long)]) });

  assert.deepEqual(model.findings, [
    `The label of Topic "Root › ${'x'.repeat(23)}…" is cut at 120 characters.`,
  ]);
  const label = model.root?.children[0]?.label ?? '';
  assert.equal([...label].length, 120);
  assert.equal(label, `${'x'.repeat(119)}…`);
});

test('a 30-character label is shortened inside the quoted path', () => {
  const thirty = 'abcdefghijklmnopqrstuvwxyz1234';
  assert.equal(thirty.length, 30);
  const model = read({ root: Topic(thirty, [Topic('y'.repeat(121))]) });

  assert.deepEqual(model.findings, [
    `The label of Topic "abcdefghijklmnopqrstuvw… › ${'y'.repeat(23)}…" is cut at 120 characters.`,
  ]);
  assert.equal(model.root?.label, thirty, 'the drawn label is not shortened');
});

test('depth, count and label findings come in that order', () => {
  // Root + the chain's B…H (7) + X + W = 10 topics, then 291 under W: 301 within 8 levels.
  const model = read({
    root: Topic('R', [
      chain(LEVELS.slice(1, 9)),
      Topic('x'.repeat(121)),
      Topic('W', leaves('w', 291)),
    ]),
  });

  assert.deepEqual(model.findings, [
    'Topic "R › B › C › D › E › F › G › H › I" is deeper than 8 levels, so it and its subtopics are not drawn.',
    'The MindMap has 301 topics, and only the first 300 are drawn: split the diagram.',
    `The label of Topic "R › ${'x'.repeat(23)}…" is cut at 120 characters.`,
  ]);
  assert.equal(model.cut.topics, 301);
  assert.equal(model.count, 300);
});

test('no root, or a root that is not a Topic with a string label: the MindMap has no topics', () => {
  for (const props of [
    {},
    { root: null },
    { root: element('Node', { id: 'a', label: 'A' }) },
    { root: Topic(42, [Topic('child')]) },
    'not props',
  ]) {
    const model = read(props);

    assert.deepEqual(
      model.findings,
      ['The MindMap has no topics.'],
      JSON.stringify(props),
    );
    assert.equal(model.root, undefined);
    assert.equal(model.count, 0);
  }
});

test('a child entry that is not a Topic is skipped without a finding', () => {
  const model = read({
    root: Topic('Root', [
      element('Node', { id: 'n', label: 'N' }),
      'text',
      Topic('B'),
    ]),
  });

  assert.deepEqual(model.findings, []);
  assert.deepEqual(preorder(model.root), ['Root', 'B']);
  assert.equal(model.count, 2);
});

test('a child Topic whose label is not a string is skipped with its subtopics, without a finding', () => {
  const model = read({
    root: Topic('Root', [Topic(7, [Topic('Deep')]), Topic('B')]),
  });

  assert.deepEqual(model.findings, []);
  assert.deepEqual(preorder(model.root), ['Root', 'B']);
  assert.equal(model.count, 2);
});

test('layout "down" reads down; "sideways" reads right, without a finding', () => {
  assert.equal(read({ root: Topic('R'), layout: 'down' }).layout, 'down');

  const model = read({ root: Topic('R'), layout: 'sideways' });
  assert.equal(model.layout, 'right');
  assert.deepEqual(model.findings, []);
});

test('an empty label stays empty, without a finding', () => {
  const model = read({ root: Topic('R', [Topic('')]) });

  assert.deepEqual(model.findings, []);
  assert.equal(model.root?.children[0]?.label, '');
});
