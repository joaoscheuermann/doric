// FT13 and FT15 (openui-diagrams.md F4, F7, F8; G4, UD8): a Flowchart drawn
// by the chunk's `ConversationFence`. While its fence streams it is an
// outline that grows with each chunk; once closed it is laid out (by a fake
// `layout`, the fence's seam) and drawn as one SVG with its outline for
// screen readers; it pans and zooms only when its fence's actions work, and a
// failed layout is shown in the diagram, never reported.

import './support/dom.js';

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { Renderer } from '@openuidev/react-lang';
import { ZOOM_STEP } from 'desktop/ui/viewport';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

import type { ChatFence } from '../../src/client/chat-contract.js';
import { ConversationFence } from '../../src/client/chunks/renderer.js';
import type {
  Box,
  LayoutGraph,
  LayoutResult,
  Point,
} from '../../src/client/diagram/layout-types.js';
import { library } from '../../src/client/library.js';
import { closeWindow, settle, window, withClientSize } from './support/dom.js';
import {
  chatFence,
  clickButton,
  fenceServices,
  mountFence,
  revisionOf,
} from './support/fence.js';

after(closeWindow);

/** Program P of the Test plan. */
const P = [
  'root = Stack([chart])',
  'chart = Flowchart(nodes, edges, groups, "down")',
  'nodes = [Node("web", "Web app", "round"), Node("api", "API", "box", "core"), Node("auth", "Auth", "box", "core"), Node("db", "Orders DB", "cylinder", "data"), Node("ok", "Healthy?", "diamond")]',
  'groups = [Group("platform", "Platform"), Group("core", "Core services", "platform"), Group("data", "Data", "platform")]',
  'edges = [Edge("web", "api", "HTTPS"), Edge("api", "auth"), Edge("api", "db", "SQL", "dashed"), Edge("api", "ok", "", "solid", "none")]',
  '',
].join('\n');

const HEADER = 'Flowchart: 5 nodes, 4 connections, 3 groups';
const STREAMING_NOTE = 'The diagram is drawn when its fence is complete.';
const NO_CONTEXT_NOTE = 'Diagrams are drawn only in the conversation.';

/** P up to and including `marker`. */
const cutAfter = (marker: string): string => {
  const at = P.indexOf(marker);
  assert.ok(at >= 0, marker);
  return P.slice(0, at + marker.length);
};

const text = (element: Element | null | undefined): string =>
  (element?.textContent ?? '').replace(/\s+/g, ' ').trim();

/** The items of the list labelled `label` (by aria-label or aria-labelledby). */
const listItems = (container: Element, label: string): string[] => {
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
  return [...list.querySelectorAll('li')].map((item) => text(item));
};

const errorCard = (container: Element) =>
  container.querySelector('[data-testid="openui-fence-errors"]');

const picture = (container: Element) =>
  container.querySelector('svg[role="img"]');

/** A layout that places the graph's nodes side by side, as ELK would place boxes. */
const fakeLayout = async (graph: LayoutGraph): Promise<LayoutResult> => {
  const nodes: Record<string, Box> = {};
  graph.nodes.forEach((node, i) => {
    nodes[node.key] = {
      x: 40 + i * 160,
      y: 60,
      width: node.width,
      height: node.height,
    };
  });
  const width = 80 + graph.nodes.length * 160;
  const groups: Record<string, Box> = {};
  graph.groups.forEach((group, i) => {
    groups[group.key] = {
      x: 10 + i * 4,
      y: 10 + i * 4,
      width: Math.max(group.minWidth, width - 20 - i * 8),
      height: 200 - i * 8,
    };
  });
  const edges: Record<string, { points: Point[]; label?: Box }> = {};
  for (const edge of graph.edges) {
    const from = nodes[edge.from] as Box;
    const to = nodes[edge.to] as Box;
    edges[edge.key] = {
      points: [
        { x: from.x + from.width / 2, y: from.y + from.height },
        { x: from.x + from.width / 2, y: 240 },
        { x: to.x + to.width / 2, y: 240 },
        { x: to.x + to.width / 2, y: to.y + to.height },
      ],
      ...(edge.label === undefined
        ? {}
        : {
            label: {
              x: from.x,
              y: 250,
              width: edge.label.width,
              height: edge.label.height,
            },
          }),
    };
  }
  return { width, height: 300, nodes, groups, edges };
};

/** A layout that never settles. */
const pendingLayout = (): Promise<LayoutResult> => new Promise(() => {});

const mountP = async (
  options: {
    readonly program?: string;
    readonly state?: ChatFence['state'];
    readonly origin?: 'user' | 'agent';
    readonly latest?: boolean;
    readonly layout?: (graph: LayoutGraph) => Promise<LayoutResult>;
    readonly sendAction?: (input: unknown) => Promise<unknown>;
  } = {},
) => {
  const fence = chatFence(options.program ?? P, {
    state: options.state ?? 'closed',
  });
  const { services, calls } = fenceServices(
    options.sendAction === undefined ? {} : { sendAction: options.sendAction },
  );
  const props = {
    view: { fence, origin: options.origin ?? 'user', fences: [fence] },
    revision: revisionOf(fence),
    latest: options.latest ?? true,
    services,
    layout: options.layout ?? fakeLayout,
  } as const;
  const mounted = await mountFence(props);
  // The faces load, the boxes are sized and the layout settles.
  await act(async () => {
    await settle(20);
  });
  return { mounted, calls, props };
};

const toolbarButton = (container: Element, label: string) =>
  [...container.querySelectorAll('button')].find(
    (button) =>
      button.getAttribute('aria-label') === label ||
      button.getAttribute('title') === label ||
      text(button) === label,
  );

const area = (container: Element): HTMLElement => {
  const found = container.querySelector(
    '[aria-label="Flowchart, pan and zoom"]',
  );
  assert.ok(found !== null, 'the focusable area');
  return found as HTMLElement;
};

interface Transform {
  readonly tx: number;
  readonly ty: number;
  readonly scale: number;
  readonly css: string;
}

/** The viewport of the drawn picture, read from the transform around its SVG. */
const transformOf = (container: Element): Transform => {
  const svg = picture(container);
  assert.ok(svg !== null, 'the picture is drawn');
  for (
    let at: HTMLElement | null = svg.parentElement;
    at !== null;
    at = at.parentElement
  ) {
    const css = at.style.transform;
    const match =
      /translate\((-?[\d.e+-]+)px,\s*(-?[\d.e+-]+)px\)\s*scale\((-?[\d.e+-]+)\)/.exec(
        css,
      );
    if (match !== null) {
      return {
        tx: Number(match[1]),
        ty: Number(match[2]),
        scale: Number(match[3]),
        css,
      };
    }
  }
  assert.fail('no viewport transform around the picture');
};

const wheel = async (
  target: Element,
  init: { deltaY: number; ctrlKey?: boolean },
): Promise<boolean> => {
  const WheelEventClass = window.WheelEvent as unknown as typeof WheelEvent;
  const event = new WheelEventClass('wheel', {
    deltaX: 0,
    deltaY: init.deltaY,
    deltaMode: 0,
    ctrlKey: init.ctrlKey ?? false,
    clientX: 50,
    clientY: 50,
    bubbles: true,
    cancelable: true,
  });
  // happy-dom's WheelEvent extends UIEvent, not MouseEvent, so it drops the
  // modifier and pointer fields a browser's wheel event carries.
  for (const [key, value] of Object.entries({
    ctrlKey: init.ctrlKey ?? false,
    metaKey: false,
    clientX: 50,
    clientY: 50,
  })) {
    Object.defineProperty(event, key, { value });
  }
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event.defaultPrevented;
};

const pointerDown = async (target: Element): Promise<void> => {
  const init = {
    button: 0,
    buttons: 1,
    isPrimary: true,
    pointerId: 1,
    pointerType: 'mouse',
    clientX: 50,
    clientY: 50,
    bubbles: true,
    cancelable: true,
  };
  await act(async () => {
    target.dispatchEvent(new PointerEvent('pointerdown', init));
    target.dispatchEvent(
      new PointerEvent('pointerup', { ...init, buttons: 0 }),
    );
  });
};

// FT13: the outline while the fence streams, and without a fence.

test('FT13: a streaming fence cut inside an edge shows the outline, its lists and the streaming note, no picture and no card', async () => {
  const body = cutAfter('Edge("api", "au');
  const fence = chatFence(body, { state: 'streaming' });
  const { services } = fenceServices();
  const mounted = await mountFence({
    view: { fence, origin: 'user', fences: [fence] },
    revision: revisionOf(fence),
    services,
    layout: pendingLayout,
  });
  const { container } = mounted;

  assert.ok(
    text(container).includes('Flowchart: 5 nodes, 1 connection, 3 groups'),
    text(container),
  );
  assert.deepEqual(listItems(container, 'Nodes'), [
    'Web app',
    'API (in Core services)',
    'Auth (in Core services)',
    'Orders DB (in Data)',
    'Healthy?',
  ]);
  assert.deepEqual(listItems(container, 'Groups'), [
    'Platform',
    'Core services (in Platform)',
    'Data (in Platform)',
  ]);
  assert.deepEqual(listItems(container, 'Connections'), [
    'Web app → API: HTTPS',
  ]);
  assert.ok(text(container).includes(STREAMING_NOTE));
  assert.equal(picture(container), null);
  assert.equal(errorCard(container), null);

  // The next chunk, in one synchronous act with no timer advanced.
  const grown = chatFence(cutAfter('Edge("api", "auth"), '), {
    state: 'streaming',
  });
  act(() => {
    mounted.root.render(
      createElement(ConversationFence, {
        view: { fence: grown, origin: 'user', fences: [grown] },
        revision: revisionOf(grown),
        latest: true,
        superseded: false,
        services,
        watchAnswers: () => () => undefined,
        layout: pendingLayout,
      }),
    );
  });

  assert.ok(
    text(container).includes('Flowchart: 5 nodes, 2 connections, 3 groups'),
    text(container),
  );
  assert.deepEqual(listItems(container, 'Connections'), [
    'Web app → API: HTTPS',
    'API → Auth',
  ]);
  await mounted.unmount();
});

test('FT13: a Flowchart of 101 nodes shows 100 of 101 nodes', async () => {
  const nodes = Array.from(
    { length: 101 },
    (_, i) => `Node("n${i}", "Node ${i}")`,
  ).join(', ');
  const program = [
    'root = Stack([chart])',
    'chart = Flowchart(nodes)',
    `nodes = [${nodes}]`,
    '',
  ].join('\n');
  const { mounted } = await mountP({
    program,
    state: 'streaming',
    layout: pendingLayout,
  });

  assert.ok(text(mounted.container).includes('100 of 101 nodes'));
  await mounted.unmount();
});

test('FT13: a closed fence of P shows the outline header and no error card', async () => {
  const { mounted } = await mountP({ layout: pendingLayout });

  assert.ok(text(mounted.container).includes(HEADER), text(mounted.container));
  assert.equal(errorCard(mounted.container), null);
  await mounted.unmount();
});

test('FT13: under a bare Renderer, with no fence, the outline and its note', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(Renderer, { response: P, library, isStreaming: false }),
    );
    await settle(10);
  });

  assert.ok(text(container).includes(HEADER), text(container));
  assert.ok(text(container).includes(NO_CONTEXT_NOTE));
  assert.equal(picture(container), null);

  await act(async () => root.unmount());
  container.remove();
});

// FT15: the picture, and pan and zoom.

test('FT15: P closed and latest in a main Thread draws one labelled picture with its outline for screen readers', async () => {
  const { mounted } = await mountP();
  const { container } = mounted;
  const svg = picture(container);
  assert.ok(svg !== null, 'an svg[role="img"]');

  const labelledBy = svg.getAttribute('aria-labelledby');
  const label =
    svg.getAttribute('aria-label') ??
    (labelledBy === null ? '' : text(document.getElementById(labelledBy)));
  assert.equal(label, HEADER);

  const describedBy = svg.getAttribute('aria-describedby');
  assert.ok(describedBy !== null, 'aria-describedby');
  const outline = document.getElementById(describedBy);
  assert.ok(outline !== null, 'the outline the picture names');
  assert.ok(outline.closest('.sr-only') !== null, 'the outline is sr-only');
  assert.ok(text(outline).includes(HEADER));

  for (const label of [
    'Web app',
    'API',
    'Auth',
    'Orders DB',
    'Healthy?',
    'Platform',
    'Core services',
    'Data',
    'HTTPS',
    'SQL',
  ]) {
    assert.ok(text(svg).includes(label), label);
  }
  const arrows = [...svg.querySelectorAll('[marker-end]')].filter(
    (part) => !['', 'none'].includes(part.getAttribute('marker-end') ?? ''),
  );
  assert.equal(arrows.length, 3, 'three edges end in an arrowhead');

  for (const name of ['Zoom out', 'Zoom in', 'Fit to view']) {
    assert.ok(toolbarButton(container, name) !== undefined, name);
  }
  assert.ok(area(container).tabIndex >= 0, 'the area is focusable');
  assert.equal(errorCard(container), null);
  await mounted.unmount();
});

test('FT15: zoom in, wheel without and with focus, ctrl-wheel, Escape', async () => {
  const { mounted } = await mountP();
  const { container } = mounted;
  const svg = picture(container) as Element;

  const fitted = transformOf(container);
  const zoomIn = toolbarButton(container, 'Zoom in');
  assert.ok(zoomIn !== undefined);
  await act(async () => {
    zoomIn.click();
  });
  const zoomed = transformOf(container);
  assert.ok(
    Math.abs(zoomed.scale - fitted.scale * ZOOM_STEP) < 1e-9,
    `${fitted.scale} → ${zoomed.scale}`,
  );

  // Not focused: a plain wheel is the conversation's.
  assert.equal(await wheel(svg, { deltaY: 40 }), false);
  assert.equal(transformOf(container).css, zoomed.css);

  // A wheel with ctrlKey zooms without focus.
  assert.equal(await wheel(svg, { deltaY: -40, ctrlKey: true }), true);
  const pinched = transformOf(container);
  assert.ok(
    Math.abs(pinched.scale - zoomed.scale * 1.1) < 1e-9,
    `${zoomed.scale} → ${pinched.scale}`,
  );

  // A pointerdown focuses the area; the same plain wheel now pans.
  await pointerDown(svg);
  assert.equal(document.activeElement, area(container));
  assert.equal(await wheel(svg, { deltaY: 40 }), true);
  const panned = transformOf(container);
  assert.equal(panned.scale, pinched.scale);
  assert.equal(panned.tx, pinched.tx);
  assert.ok(Math.abs(panned.ty - (pinched.ty - 40)) < 1e-9);

  // Escape gives the wheel back.
  await act(async () => {
    area(container).dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  assert.notEqual(document.activeElement, area(container));
  assert.equal(await wheel(svg, { deltaY: 40 }), false);
  await mounted.unmount();
});

test('FT15: in an agent Thread, an older revision or an unterminated fence the picture is static', async () => {
  const cases = [
    { name: 'agent Thread', options: { origin: 'agent' as const } },
    { name: 'older revision', options: { latest: false } },
    { name: 'unterminated', options: { state: 'unterminated' as const } },
  ];

  for (const { name, options } of cases) {
    const { mounted } = await mountP(options);
    const { container } = mounted;
    const svg = picture(container);
    assert.ok(svg !== null, `${name}: drawn`);
    for (const label of ['Zoom out', 'Zoom in', 'Fit to view']) {
      assert.equal(
        toolbarButton(container, label),
        undefined,
        `${name}: ${label}`,
      );
    }
    assert.equal(
      container.querySelector('[tabindex]'),
      null,
      `${name}: tabindex`,
    );
    assert.equal(
      await wheel(svg, { deltaY: -40, ctrlKey: true }),
      false,
      `${name}: ctrl-wheel`,
    );
    await mounted.unmount();
  }
});

test('FT15: when a newer revision arrives, the picture loses its toolbar and returns to the fit', async () => {
  const { mounted, props } = await mountP();
  const { container } = mounted;
  const fitted = transformOf(container).css;

  const zoomIn = toolbarButton(container, 'Zoom in');
  assert.ok(zoomIn !== undefined);
  await act(async () => {
    zoomIn.click();
  });
  assert.notEqual(transformOf(container).css, fitted);

  await mounted.update({ ...props, latest: false });
  await act(async () => {
    await settle(10);
  });

  assert.equal(toolbarButton(container, 'Zoom in'), undefined);
  assert.equal(transformOf(container).css, fitted);
  await mounted.unmount();
});

test('FT15: a layout that rejects shows the outline and its message, and reports nothing more', async () => {
  const { mounted, calls } = await mountP({
    layout: () => Promise.reject(new Error('boom')),
  });
  const { container } = mounted;
  await act(async () => {
    await settle(50);
  });

  assert.ok(text(container).includes(HEADER));
  assert.ok(text(container).includes('This diagram could not be drawn: boom'));
  assert.equal(picture(container), null);
  assert.equal(errorCard(container), null);
  assert.equal(JSON.stringify(calls.reports).includes('boom'), false);
  assert.equal(
    JSON.stringify(calls.reports).includes('could not be drawn'),
    false,
  );
  await mounted.unmount();
});

test('FT15: a layout that settles after the fence unmounted changes nothing', async () => {
  let settleLayout: ((result: LayoutResult) => void) | undefined;
  let laidOut: LayoutGraph | undefined;
  const { mounted } = await mountP({
    layout: (graph) => {
      laidOut = graph;
      return new Promise((resolve) => {
        settleLayout = resolve;
      });
    },
  });
  assert.ok(settleLayout !== undefined && laidOut !== undefined);
  const { container } = mounted;

  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  try {
    await mounted.unmount();
    settleLayout(await fakeLayout(laidOut));
    await act(async () => {
      await settle(20);
    });
  } finally {
    console.error = original;
  }

  assert.deepEqual(errors, []);
  assert.equal(container.childElementCount, 0);
});

test('FT15: while a click of the same fence is sending, the wrapper is inert, the toolbar and the pan stay, nothing refits', async () => {
  const program = P.replace(
    'root = Stack([chart])',
    'root = Stack([chart, btns])\nbtns = Buttons([b])\nb = Button("Tag it")',
  );
  const { mounted, calls } = await mountP({
    program,
    sendAction: () => new Promise(() => {}),
  });
  const { container } = mounted;
  const svg = picture(container) as Element;

  await pointerDown(svg);
  assert.equal(await wheel(svg, { deltaY: 40 }), true);
  const panned = transformOf(container).css;

  await clickButton(container, 'Tag it');
  await act(async () => {
    await settle(20);
  });
  assert.equal(calls.actions.length, 1);

  const inert = container.querySelector('[inert]');
  assert.ok(inert?.contains(svg), 'the wrapper is inert');
  assert.ok(toolbarButton(container, 'Zoom in') !== undefined);
  assert.equal(transformOf(container).css, panned);

  await act(async () => {
    await settle(600);
  });
  assert.equal(transformOf(container).css, panned);
  await mounted.unmount();
});

// FT39 (openui-diagrams-square-area.md): a resize of the square area refits
// the drawing until the reader pans or zooms. fakeLayout lays P out at
// 880×300; fitted with a 24 px margin into 400×400 that is scale 0.4,
// translate (24, 140).

const RESIZED_FIT = { scale: 0.4, tx: 24, ty: 140 };

const assertFit = (actual: Transform, expected: typeof RESIZED_FIT): void => {
  for (const key of ['scale', 'tx', 'ty'] as const) {
    assert.ok(
      Math.abs(actual[key] - expected[key]) < 1e-6,
      `${key}: ${actual[key]} ≠ ${expected[key]}`,
    );
  }
};

/**
 * Mounts P in a 600×600 area whose ResizeObserver is a stub; `resize`
 * makes the area 400×400 and calls the observers' callbacks.
 */
const withResizableP = async (
  run: (container: HTMLElement, resize: () => Promise<void>) => Promise<void>,
): Promise<void> => {
  const size = { width: 600, height: 600 };
  await withClientSize(size, async () => {
    const original = globalThis.ResizeObserver;
    const callbacks = new Set<ResizeObserverCallback>();
    class StubResizeObserver {
      readonly #callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.#callback = callback;
        callbacks.add(callback);
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {
        callbacks.delete(this.#callback);
      }
    }
    globalThis.ResizeObserver =
      StubResizeObserver as unknown as typeof ResizeObserver;
    try {
      const { mounted } = await mountP();
      const resize = async (): Promise<void> => {
        size.width = 400;
        size.height = 400;
        await act(async () => {
          for (const callback of [...callbacks]) {
            callback([], {} as ResizeObserver);
          }
        });
      };
      try {
        await run(mounted.container, resize);
      } finally {
        await mounted.unmount();
      }
    } finally {
      globalThis.ResizeObserver = original;
    }
  });
};

const clickToolbar = async (container: Element, label: string) => {
  const button = toolbarButton(container, label);
  assert.ok(button !== undefined, label);
  await act(async () => {
    button.click();
  });
};

test('FT39: a resize of the area refits the drawing', async () => {
  await withResizableP(async (container, resize) => {
    await resize();
    assertFit(transformOf(container), RESIZED_FIT);
  });
});

test("FT39: after a zoom, a resize keeps the reader's viewport", async () => {
  await withResizableP(async (container, resize) => {
    await clickToolbar(container, 'Zoom in');
    const zoomed = transformOf(container).css;
    await resize();
    assert.equal(transformOf(container).css, zoomed);
  });
});

test('FT39: Fit to view after a resize fits the new size', async () => {
  await withResizableP(async (container, resize) => {
    await clickToolbar(container, 'Zoom in');
    await resize();
    await clickToolbar(container, 'Fit to view');
    assertFit(transformOf(container), RESIZED_FIT);
  });
});
