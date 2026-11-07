// FT10 (openui-diagrams.md F6): the layout loader loads the layout chunk at
// the first layout and never again, and keeps a rejected load: that layout
// and every later one reject with its error. A fake module stands for the
// chunk, the loader's only boundary.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createLayoutLoader } from '../../src/client/diagram/layout-loader.js';
import type {
  LayoutGraph,
  LayoutResult,
} from '../../src/client/diagram/layout-types.js';

const graph = (key: string): LayoutGraph => ({
  direction: 'down',
  groupPadding: { top: 30, side: 12 },
  nodes: [{ key, width: 80, height: 40 }],
  groups: [],
  edges: [],
});

const resultOf = (input: LayoutGraph): LayoutResult => ({
  width: 100,
  height: 60,
  nodes: Object.fromEntries(
    input.nodes.map((node) => [
      node.key,
      { x: 10, y: 10, width: node.width, height: node.height },
    ]),
  ),
  groups: {},
  edges: {},
});

test('the chunk is loaded at the first layout, once for three layouts, and each layout is the module’s', async () => {
  let loads = 0;
  const layout = createLayoutLoader(async () => {
    loads += 1;
    return { layout: async (input: LayoutGraph) => resultOf(input) };
  });

  assert.equal(loads, 0);

  const results = await Promise.all([layout(graph('n0')), layout(graph('n1'))]);
  const third = await layout(graph('n2'));

  assert.equal(loads, 1);
  assert.deepEqual(results, [resultOf(graph('n0')), resultOf(graph('n1'))]);
  assert.deepEqual(third, resultOf(graph('n2')));
});

test('a rejected load rejects that layout and every later one with its error, without loading again', async () => {
  let loads = 0;
  const boom = new Error('chunk did not load');
  const layout = createLayoutLoader(async () => {
    loads += 1;
    throw boom;
  });

  for (const key of ['n0', 'n1', 'n2']) {
    await assert.rejects(layout(graph(key)), (error) => error === boom);
  }
  assert.equal(loads, 1);
});

test('a rejecting module layout rejects that layout only', async () => {
  const failure = new Error('ELK failed');
  let calls = 0;
  const layout = createLayoutLoader(async () => ({
    layout: async (input: LayoutGraph) => {
      calls += 1;
      if (calls === 1) throw failure;
      return resultOf(input);
    },
  }));

  await assert.rejects(layout(graph('n0')), (error) => error === failure);
  assert.deepEqual(await layout(graph('n1')), resultOf(graph('n1')));
});
