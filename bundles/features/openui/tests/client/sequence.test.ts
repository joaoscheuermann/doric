// FT31, FT32 and FT37 (openui-diagrams-phase2.md F16, F17, F19, F20; G4, G5,
// A5): a SequenceDiagram drawn by the chunk's `ConversationFence`. While its
// fence streams it is an outline nested by fragment and section that grows
// with each chunk; once closed it is laid out by `layoutSequence` in the
// renderer chunk, never by the layout chunk, and drawn as one SVG.

import './support/dom.js';

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { act, createElement } from 'react';

import type { ChatFence } from '../../src/client/chat-contract.js';
import { programCheck } from '../../src/client/check.js';
import { ConversationFence } from '../../src/client/chunks/renderer.js';
import type {
  LayoutGraph,
  LayoutResult,
} from '../../src/client/diagram/layout-types.js';
import { closeWindow, settle } from './support/dom.js';
import {
  chatFence,
  fenceServices,
  mountFence,
  revisionOf,
} from './support/fence.js';

after(closeWindow);

/** Three participants; an alt whose first section holds a nested loop. */
const SEQ = [
  'root = Stack([seq])',
  'seq = SequenceDiagram(participants, steps)',
  'participants = [Participant("web", "Browser"), Participant("api", "API"), Participant("db", "Database")]',
  'steps = [Message("web", "api", "POST /login"), Fragment("alt", [Section("valid", [Message("api", "db", "SELECT user"), Fragment("loop", [Section("each role", [Message("api", "api", "check role")])]), Message("api", "web", "200 OK", "reply")]), Section("invalid", [Note("logs the attempt", ["api"]), Message("api", "web", "401", "reply")])])]',
  '',
].join('\n');

const HEADER = 'Sequence diagram: 3 participants, 8 steps';

const text = (element: Element | null | undefined): string =>
  (element?.textContent ?? '').replace(/\s+/g, ' ').trim();

/** SEQ up to and including `marker`. */
const cutAfter = (marker: string): string => {
  const at = SEQ.indexOf(marker);
  assert.ok(at >= 0, marker);
  return SEQ.slice(0, at + marker.length);
};

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

/** A layout that records its calls and never settles. */
const recordingLayout = () => {
  const calls: LayoutGraph[] = [];
  const layout = (graph: LayoutGraph): Promise<LayoutResult> => {
    calls.push(graph);
    return new Promise(() => {});
  };
  return { calls, layout };
};

const fenceProps = (
  fence: ChatFence,
  services: ReturnType<typeof fenceServices>['services'],
  layout: (graph: LayoutGraph) => Promise<LayoutResult>,
  latest = true,
) => ({
  view: { fence, origin: 'user' as const, fences: [fence] },
  revision: revisionOf(fence),
  latest,
  services,
  layout,
});

const NUMBER = /-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi;

/** The x, y pairs a line, polyline or path draws through. */
const coordinates = (element: Element): { x: number; y: number }[] => {
  if (element.tagName.toLowerCase() === 'line') {
    return [
      {
        x: Number(element.getAttribute('x1')),
        y: Number(element.getAttribute('y1')),
      },
      {
        x: Number(element.getAttribute('x2')),
        y: Number(element.getAttribute('y2')),
      },
    ];
  }
  const numbers =
    (element.getAttribute('points') ?? element.getAttribute('d') ?? '')
      .match(NUMBER)
      ?.map(Number) ?? [];
  const pairs: { x: number; y: number }[] = [];
  for (let i = 0; i + 1 < numbers.length; i += 2) {
    pairs.push({ x: numbers[i] as number, y: numbers[i + 1] as number });
  }
  return pairs;
};

const isDashed = (element: Element) => {
  const dashes =
    element.getAttribute('stroke-dasharray') ??
    (element as SVGElement & ElementCSSInlineStyle).style.getPropertyValue(
      'stroke-dasharray',
    );
  return dashes !== null && dashes !== '' && dashes !== 'none';
};

/** Dashed straight lines that run along one axis. */
const dashed = (svg: Element, axis: 'vertical' | 'horizontal'): Element[] =>
  [...svg.querySelectorAll('line, polyline, path')].filter((element) => {
    if (!isDashed(element)) return false;
    const points = coordinates(element);
    if (points.length < 2) return false;
    const [first] = points as [{ x: number; y: number }];
    return axis === 'vertical'
      ? points.every((point) => point.x === first.x) &&
          points.some((point) => point.y !== first.y)
      : points.every((point) => point.y === first.y) &&
          points.some((point) => point.x !== first.x);
  });

const zoomIn = (container: Element) =>
  [...container.querySelectorAll('button')].find(
    (button) =>
      button.getAttribute('aria-label') === 'Zoom in' ||
      button.getAttribute('title') === 'Zoom in' ||
      text(button) === 'Zoom in',
  );

// FT31: the outline while the fence streams.

test('FT31: a streaming fence cut inside a nested Section shows the steps so far, nested by fragment and section; the next chunk shows within one act', async () => {
  const { layout } = recordingLayout();
  const fence = chatFence(
    cutAfter('Section("each role", [Message("api", "api", "check role")'),
    { state: 'streaming' },
  );
  const { services } = fenceServices();
  const mounted = await mountFence(fenceProps(fence, services, layout));
  const { container } = mounted;

  assert.ok(
    text(container).includes('Sequence diagram: 3 participants, 5 steps'),
    text(container),
  );
  assert.deepEqual(treeOf(listLabelled(container, 'Steps')), [
    leaf('Browser → API: POST /login'),
    {
      text: 'alt',
      children: [
        {
          text: 'valid',
          children: [
            leaf('API → Database: SELECT user'),
            {
              text: 'loop',
              children: [
                {
                  text: 'each role',
                  children: [leaf('API → API: check role')],
                },
              ],
            },
          ],
        },
      ],
    },
  ]);
  assert.equal(picture(container), null);

  // The next chunk, in one synchronous act with no timer advanced.
  const grown = chatFence(
    cutAfter('Message("api", "web", "200 OK", "reply")'),
    { state: 'streaming' },
  );
  act(() => {
    mounted.root.render(
      createElement(ConversationFence, {
        ...fenceProps(grown, services, layout),
        superseded: false,
        watchAnswers: () => () => undefined,
      }),
    );
  });

  assert.ok(
    text(container).includes('Sequence diagram: 3 participants, 6 steps'),
    text(container),
  );
  const valid = treeOf(listLabelled(container, 'Steps'))[1]?.children[0];
  assert.deepEqual(
    valid?.children.at(-1),
    leaf('API → Browser (reply): 200 OK'),
  );
  await mounted.unmount();
});

// FT32 and FT37: the picture, without the layout chunk.

test('FT32, FT37: a closed sequence is drawn without the layout, every part of the nested fragments with it', async () => {
  const { calls, layout } = recordingLayout();
  const fence = chatFence(SEQ);
  const { services } = fenceServices();
  const mounted = await mountFence(fenceProps(fence, services, layout));
  await act(async () => {
    await settle(20);
  });
  const { container } = mounted;

  const svg = picture(container);
  assert.ok(svg !== null, 'an svg[role="img"]');
  assert.equal(container.querySelectorAll('svg[role="img"]').length, 1);
  assert.equal(svg.getAttribute('aria-label'), HEADER);
  assert.ok(
    container.querySelector('[aria-label="Sequence diagram, pan and zoom"]') !==
      null,
    'the area is labelled',
  );
  assert.equal(calls.length, 0, 'the layout chunk is never asked');

  for (const label of [
    'Browser',
    'API',
    'Database',
    'POST /login',
    'SELECT user',
    'check role',
    '200 OK',
    '401',
    'logs the attempt',
    'alt',
    'loop',
    '[valid]',
    '[invalid]',
    '[each role]',
  ]) {
    assert.ok(text(svg).includes(label), label);
  }
  assert.equal(
    dashed(svg, 'vertical').length,
    3,
    'one dashed lifeline per participant',
  );
  // Two replies and the separator before the alt's second section.
  assert.equal(
    dashed(svg, 'horizontal').length,
    3,
    'reply arrows and the separator are dashed',
  );

  // The check gives no line (FT37).
  assert.deepEqual(programCheck(revisionOf(fence)), []);
  await mounted.unmount();
});

test('FT32: in an older revision the drawn sequence has no toolbar', async () => {
  const { layout } = recordingLayout();
  const fence = chatFence(SEQ);
  const { services } = fenceServices();

  const latest = await mountFence(fenceProps(fence, services, layout, true));
  await act(async () => {
    await settle(20);
  });
  assert.ok(
    zoomIn(latest.container) !== undefined,
    'the latest revision has a toolbar',
  );
  await latest.unmount();

  const older = await mountFence(fenceProps(fence, services, layout, false));
  await act(async () => {
    await settle(20);
  });
  assert.ok(picture(older.container) !== null, 'drawn');
  assert.equal(zoomIn(older.container), undefined, 'no toolbar');
  await older.unmount();
});
