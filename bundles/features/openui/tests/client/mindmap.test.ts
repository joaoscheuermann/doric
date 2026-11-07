// FT22 and FT37 (openui-diagrams-phase2.md F16, F17, F20; G4, A5): a MindMap
// drawn by the chunk's `ConversationFence`. While its fence streams it is a
// nested outline; once closed it is laid out (by a fake `layout`, the fence's
// seam) and drawn as one SVG of round topics joined by lines, with its outline
// for screen readers. A failed layout is shown in the diagram.

import './support/dom.js';

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { act } from 'react';

import type { ChatFence } from '../../src/client/chat-contract.js';
import { programCheck } from '../../src/client/check.js';
import { cssColor, DIAGRAM_COLORS } from '../../src/client/diagram/colors.js';
import type {
  Box,
  LayoutGraph,
  LayoutResult,
  Point,
} from '../../src/client/diagram/layout-types.js';
import { closeWindow, settle } from './support/dom.js';
import {
  chatFence,
  fenceServices,
  mountFence,
  revisionOf,
} from './support/fence.js';

after(closeWindow);

/** A map of four levels in F22's form: the root topic, then one statement per branch. */
const MAP = [
  'root = Stack([map])',
  'map = MindMap(top, "right")',
  'top = Topic("Launch", [b1, b2])',
  'b1 = Topic("Marketing", [Topic("Ads"), Topic("Social", [Topic("Video")])])',
  'b2 = Topic("Sales", [Topic("Partners"), Topic("Retail")])',
  '',
].join('\n');

const LABELS = [
  'Launch',
  'Marketing',
  'Ads',
  'Social',
  'Video',
  'Sales',
  'Partners',
  'Retail',
];

const STREAMING_NOTE = 'The diagram is drawn when its fence is complete.';

const text = (element: Element | null | undefined): string =>
  (element?.textContent ?? '').replace(/\s+/g, ' ').trim();

/** MAP up to and including `marker`. */
const cutAfter = (marker: string): string => {
  const at = MAP.indexOf(marker);
  assert.ok(at >= 0, marker);
  return MAP.slice(0, at + marker.length);
};

/** The list labelled `label` (by aria-label or aria-labelledby). */
const listLabelled = (container: Element, label: string): Element => {
  const list = [...container.querySelectorAll('ul')].find((candidate) => {
    if (candidate.getAttribute('aria-label') === label) return true;
    const by = candidate.getAttribute('aria-labelledby');
    return (
      by !== null &&
      by
        .split(/\s+/)
        .map((id) => text(document.getElementById(id)))
        .join(' ') === label
    );
  });
  assert.ok(list !== undefined, `a list labelled ${label}`);
  return list;
};

interface Tree {
  readonly text: string;
  readonly children: readonly Tree[];
}

/** A list's items as a tree: each item's own text, and its nested list's items. */
const treeOf = (list: Element): Tree[] =>
  [...list.children]
    .filter((item) => item.tagName.toLowerCase() === 'li')
    .map((item) => {
      const nested = [...item.children].find(
        (child) => child.tagName.toLowerCase() === 'ul',
      );
      const own = [...item.childNodes]
        .filter((child) => child !== nested)
        .map((child) => child.textContent ?? '')
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
      return {
        text: own,
        children: nested === undefined ? [] : treeOf(nested),
      };
    });

const leaf = (label: string): Tree => ({ text: label, children: [] });

const picture = (container: Element) =>
  container.querySelector('svg[role="img"]');

const errorCard = (container: Element) =>
  container.querySelector('[data-testid="openui-fence-errors"]');

/** A layout that places the graph's nodes side by side and joins each edge's ends. */
const fakeLayout = async (graph: LayoutGraph): Promise<LayoutResult> => {
  const nodes: Record<string, Box> = {};
  graph.nodes.forEach((node, i) => {
    nodes[node.key] = {
      x: 40 + i * 180,
      y: 40 + (i % 2) * 80,
      width: node.width,
      height: node.height,
    };
  });
  const edges: Record<string, { points: Point[] }> = {};
  for (const edge of graph.edges) {
    const from = nodes[edge.from] as Box;
    const to = nodes[edge.to] as Box;
    edges[edge.key] = {
      points: [
        { x: from.x + from.width, y: from.y + from.height / 2 },
        { x: to.x, y: to.y + to.height / 2 },
      ],
    };
  }
  return {
    width: 80 + graph.nodes.length * 180,
    height: 240,
    nodes,
    groups: {},
    edges,
  };
};

/** A layout that never settles. */
const pendingLayout = (): Promise<LayoutResult> => new Promise(() => {});

const mount = async (options: {
  readonly program?: string;
  readonly state?: ChatFence['state'];
  readonly layout: (graph: LayoutGraph) => Promise<LayoutResult>;
}) => {
  const fence = chatFence(options.program ?? MAP, {
    state: options.state ?? 'closed',
  });
  const { services } = fenceServices();
  const mounted = await mountFence({
    view: { fence, origin: 'user', fences: [fence] },
    revision: revisionOf(fence),
    services,
    layout: options.layout,
  });
  // The faces load, the boxes are sized and the layout settles.
  await act(async () => {
    await settle(20);
  });
  return { mounted, fence };
};

const fillOf = (element: Element): string =>
  element.getAttribute('fill') ??
  (element as SVGElement & ElementCSSInlineStyle).style.getPropertyValue(
    'fill',
  );

/** The drawn element whose x, y, width and height are `box`'s. */
const shapeAt = (svg: Element, box: Box): Element | undefined =>
  [...svg.querySelectorAll('rect')].find(
    (rect) =>
      Number(rect.getAttribute('x')) === box.x &&
      Number(rect.getAttribute('y')) === box.y &&
      Number(rect.getAttribute('width')) === box.width &&
      Number(rect.getAttribute('height')) === box.height,
  );

// FT22: the outline while the fence streams.

test('FT22: a streaming fence cut inside the second branch shows the nested outline written so far, no picture', async () => {
  const { mounted } = await mount({
    program: cutAfter('b2 = Topic("Sales", [Topic("Partners"), '),
    state: 'streaming',
    layout: pendingLayout,
  });
  const { container } = mounted;

  assert.ok(text(container).includes('Mind map: 7 topics'), text(container));
  assert.deepEqual(treeOf(listLabelled(container, 'Topics')), [
    {
      text: 'Launch',
      children: [
        {
          text: 'Marketing',
          children: [
            leaf('Ads'),
            { text: 'Social', children: [leaf('Video')] },
          ],
        },
        { text: 'Sales', children: [leaf('Partners')] },
      ],
    },
  ]);
  assert.ok(text(container).includes(STREAMING_NOTE));
  assert.equal(picture(container), null);
  assert.equal(errorCard(container), null);
  await mounted.unmount();
});

// FT22 and FT37: the picture.

test('FT22, FT37: a closed map draws one labelled svg, a round shape per topic, a line per edge, the root filled group2', async () => {
  const graphs: LayoutGraph[] = [];
  const results: LayoutResult[] = [];
  const { mounted, fence } = await mount({
    layout: async (graph) => {
      graphs.push(graph);
      const result = await fakeLayout(graph);
      results.push(result);
      return result;
    },
  });
  const { container } = mounted;
  const svg = picture(container);
  assert.ok(svg !== null, 'an svg[role="img"]');
  assert.equal(container.querySelectorAll('svg[role="img"]').length, 1);
  assert.equal(svg.getAttribute('aria-label'), 'Mind map: 8 topics');
  const describedBy = svg.getAttribute('aria-describedby');
  assert.ok(describedBy !== null, 'aria-describedby');
  assert.ok(
    document.getElementById(describedBy)?.closest('.sr-only') !== null,
    'the outline is sr-only',
  );
  assert.ok(
    container.querySelector('[aria-label="Mind map, pan and zoom"]') !== null,
    'the area is labelled',
  );

  // Every topic of every level is drawn (FT37).
  for (const label of LABELS) {
    assert.ok(text(svg).includes(label), label);
  }

  const result = results.at(-1);
  assert.ok(result !== undefined, 'the layout was called');
  const boxes = Object.values(result.nodes);
  assert.equal(boxes.length, 8, 'one node per topic');
  for (const box of boxes) {
    const shape = shapeAt(svg, box);
    assert.ok(shape !== undefined, `a shape at ${JSON.stringify(box)}`);
    assert.equal(Number(shape.getAttribute('rx')), box.height / 2, 'round');
  }
  const root = shapeAt(svg, result.nodes.n0 as Box);
  assert.ok(root !== undefined, 'the root n0 is drawn');
  assert.equal(fillOf(root), cssColor(DIAGRAM_COLORS.group2));
  const others = boxes.filter((box) => box !== result.nodes.n0);
  for (const box of others) {
    assert.equal(
      fillOf(shapeAt(svg, box) as Element),
      cssColor(DIAGRAM_COLORS.nodeFill),
    );
  }
  assert.equal(
    svg.querySelectorAll('path, polyline').length,
    7,
    'one line per edge',
  );
  assert.equal(errorCard(container), null);

  // The check gives no line for the map (FT37).
  assert.deepEqual(programCheck(revisionOf(fence)), []);
  await mounted.unmount();
});

test('FT22: layout "down" labels the picture a tree', async () => {
  const { mounted } = await mount({
    program: MAP.replace('MindMap(top, "right")', 'MindMap(top, "down")'),
    layout: fakeLayout,
  });
  const { container } = mounted;

  assert.equal(
    picture(container)?.getAttribute('aria-label'),
    'Tree: 8 topics',
  );
  assert.ok(
    container.querySelector('[aria-label="Tree, pan and zoom"]') !== null,
    'the area is labelled as a tree',
  );
  await mounted.unmount();
});

test('FT22: a layout that rejects shows the outline and its message', async () => {
  const { mounted } = await mount({
    layout: () => Promise.reject(new Error('boom')),
  });
  const { container } = mounted;

  assert.ok(text(container).includes('Mind map: 8 topics'), text(container));
  assert.ok(
    text(container).includes('This diagram could not be drawn: boom'),
    text(container),
  );
  assert.equal(picture(container), null);
  await mounted.unmount();
});
