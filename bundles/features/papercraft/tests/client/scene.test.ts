// The frame's scene (`scene.ts`): the bounds of each derived node, in content
// coordinates, are its own border box, cut to what its clipping ancestors
// leave visible; each out-of-flow (`absolute` / `fixed`) `::before` /
// `::after` box is measured on its own (`pseudoBounds`), so the reader can
// point at it as a target of its own — a point on it answers the pseudo, and
// an offset is measured in its box.
//
// happy-dom lays nothing out and computes no pseudo-element styles: the
// layout is the boundary these tests fake — each element's
// `getBoundingClientRect` and the window's `getComputedStyle(element, pseudo)`.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Window } from 'happy-dom';

import { offsetIn } from '../../src/client/surface/pin-geometry.js';
import { type Scene, sceneOf } from '../../src/client/surface/scene.js';
import {
  type Bounds,
  hitTest,
  pseudoAt,
  type SceneNode,
  targetBounds,
} from '../../src/client/surface/scene-graph.js';

/** The computed style of an element, as far as the layout fake answers. */
interface BoxStyle {
  readonly position: string;
  readonly overflowX: string;
  readonly overflowY: string;
  readonly borderLeftWidth: string;
  readonly borderTopWidth: string;
  readonly borderRightWidth: string;
  readonly borderBottomWidth: string;
}

/** The computed style of a `::before`/`::after`. */
interface PseudoDeclaration {
  readonly content: string;
  readonly position: string;
  readonly left: string;
  readonly top: string;
  readonly right: string;
  readonly bottom: string;
  readonly marginLeft: string;
  readonly marginTop: string;
  readonly marginRight: string;
  readonly marginBottom: string;
}

interface Layout {
  /** The border box in viewport coordinates. */
  readonly rect: Bounds;
  readonly style?: Partial<BoxStyle> & { readonly overflow?: string };
  readonly before?: Partial<PseudoDeclaration>;
  readonly after?: Partial<PseudoDeclaration>;
}

const BOX: BoxStyle = {
  position: 'static',
  overflowX: 'visible',
  overflowY: 'visible',
  borderLeftWidth: '0px',
  borderTopWidth: '0px',
  borderRightWidth: '0px',
  borderBottomWidth: '0px',
};

const NO_PSEUDO: PseudoDeclaration = {
  content: 'none',
  position: 'static',
  left: 'auto',
  top: 'auto',
  right: 'auto',
  bottom: 'auto',
  marginLeft: '0px',
  marginTop: '0px',
  marginRight: '0px',
  marginBottom: '0px',
};

const happy = new Window();
const layouts = new WeakMap<object, Layout>();

/** A declaration that also answers `getPropertyValue('kebab-case')`. */
const declaration = (values: Record<string, string>): CSSStyleDeclaration =>
  ({
    display: 'block',
    ...values,
    getPropertyValue: (name: string): string =>
      values[
        name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())
      ] ?? '',
  }) as unknown as CSSStyleDeclaration;

const realComputedStyle = happy.getComputedStyle.bind(happy) as unknown as (
  element: unknown,
  pseudo?: string | null,
) => CSSStyleDeclaration;

Object.defineProperty(happy, 'getComputedStyle', {
  configurable: true,
  writable: true,
  value: (element: object, pseudo?: string | null) => {
    const layout = layouts.get(element);

    if (layout === undefined) {
      return realComputedStyle(element, pseudo);
    }

    const kind = (pseudo ?? '').replace(/^:+/, '');

    if (kind === 'before' || kind === 'after') {
      return declaration({ ...NO_PSEUDO, ...layout[kind] });
    }

    const overflow = layout.style?.overflow;

    return declaration({
      ...BOX,
      ...(overflow === undefined
        ? {}
        : { overflow, overflowX: overflow, overflowY: overflow }),
      ...layout.style,
    } as Record<string, string>);
  },
});

const lay = (element: Element, layout: Layout): void => {
  layouts.set(element, layout);

  const { x, y, width, height } = layout.rect;

  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      x,
      y,
      width,
      height,
      left: x,
      top: y,
      right: x + width,
      bottom: y + height,
      toJSON: () => ({}),
    }),
  });
};

interface Stage {
  readonly scene: Scene;
  readonly nodeOf: (selector: string) => SceneNode;
}

/**
 * Renders `markup` inside a preview's content root, lays the content out at
 * `content` and each selected element at its layout, and derives the scene.
 */
const stage = (
  markup: string,
  elements: Record<string, Layout>,
  options: { readonly scale?: number; readonly content?: Bounds } = {},
): Stage => {
  const host = happy.document.createElement('div');
  happy.document.body.appendChild(host);

  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<div class="papercraft-content">${markup}</div>`;

  const content = root.querySelector(
    '.papercraft-content',
  ) as unknown as Element;
  lay(content, {
    rect: options.content ?? { x: 0, y: 0, width: 800, height: 600 },
    style: { position: 'relative' },
  });

  for (const [selector, layout] of Object.entries(elements)) {
    lay(root.querySelector(selector) as unknown as Element, layout);
  }

  const scale = options.scale ?? 1;
  const scene = sceneOf(root as unknown as ShadowRoot, () => scale);

  return {
    scene,
    nodeOf: (selector) => {
      const element = root.querySelector(selector) as unknown as Element;
      const node = scene.graph.nodes.find((each) => each.element === element);

      assert.ok(node, `no derived node for ${selector}`);

      return node;
    },
  };
};

/** A positioned 100×40 host with an `::after` strip 4px tall right below it. */
const STRIP: Layout = {
  rect: { x: 0, y: 0, width: 100, height: 40 },
  style: { position: 'relative' },
  after: {
    content: '""',
    position: 'absolute',
    left: '0px',
    top: '40px',
    right: '0px',
    bottom: '-4px',
  },
};

const strip = (): Stage => stage('<div id="host"></div>', { '#host': STRIP });

test('a positioned host keeps its own box and measures its absolute pseudo-element apart', () => {
  const { scene, nodeOf } = strip();
  const host = nodeOf('#host');

  assert.deepEqual(scene.bounds(host), { x: 0, y: 0, width: 100, height: 40 });
  assert.deepEqual(scene.pseudoBounds(host, '::after'), {
    x: 0,
    y: 40,
    width: 100,
    height: 4,
  });
});

test('a static host places its absolute pseudo-element in the nearest positioned ancestor', () => {
  const { scene, nodeOf } = stage(
    '<section id="frame"><span id="host"></span></section>',
    {
      '#frame': {
        rect: { x: 0, y: 0, width: 200, height: 100 },
        style: { position: 'relative' },
      },
      '#host': {
        rect: { x: 60, y: 10, width: 40, height: 20 },
        before: {
          content: '""',
          position: 'absolute',
          left: '10px',
          top: '10px',
          right: '180px',
          bottom: '70px',
        },
      },
    },
  );
  const host = nodeOf('#host');

  assert.deepEqual(scene.pseudoBounds(host, '::before'), {
    x: 10,
    y: 10,
    width: 10,
    height: 20,
  });
  assert.deepEqual(scene.bounds(host), { x: 60, y: 10, width: 40, height: 20 });
});

test('an empty host drawn only by its pseudo-element keeps its empty box', () => {
  const { scene, nodeOf } = stage('<i id="host"></i>', {
    '#host': {
      rect: { x: 30, y: 30, width: 0, height: 0 },
      style: { position: 'relative' },
      before: {
        content: '""',
        position: 'absolute',
        left: '0px',
        top: '0px',
        right: '-20px',
        bottom: '-20px',
      },
    },
  });
  const host = nodeOf('#host');

  assert.deepEqual(scene.bounds(host), { x: 30, y: 30, width: 0, height: 0 });
  assert.deepEqual(scene.pseudoBounds(host, '::before'), {
    x: 30,
    y: 30,
    width: 20,
    height: 20,
  });
});

test('a pseudo-element that is absent or in flow has no box of its own', () => {
  const rect = { x: 10, y: 10, width: 50, height: 20 };
  const { scene, nodeOf } = stage(
    '<div id="plain"></div><div id="relative"></div><div id="static"></div>',
    {
      '#plain': { rect, style: { position: 'relative' } },
      '#relative': {
        rect,
        style: { position: 'relative' },
        after: {
          content: '""',
          position: 'relative',
          left: '0px',
          top: '40px',
          right: '0px',
          bottom: '-60px',
        },
      },
      '#static': {
        rect,
        style: { position: 'relative' },
        before: {
          content: '""',
          position: 'static',
          left: '-30px',
          top: '-30px',
          right: '0px',
          bottom: '0px',
        },
      },
    },
  );

  for (const selector of ['#plain', '#relative', '#static']) {
    const node = nodeOf(selector);

    assert.equal(scene.pseudoBounds(node, '::before'), undefined, selector);
    assert.equal(scene.pseudoBounds(node, '::after'), undefined, selector);
    assert.deepEqual(scene.bounds(node), rect, selector);
  }
});

test('a host that hides its overflow leaves its outside pseudo-element no box', () => {
  const { scene, nodeOf } = stage('<div id="host"></div>', {
    '#host': { ...STRIP, style: { position: 'relative', overflow: 'hidden' } },
  });

  assert.equal(scene.pseudoBounds(nodeOf('#host'), '::after'), undefined);
});

test('a clipping ancestor cuts the pseudo-element box, and the host keeps its own', () => {
  const { scene, nodeOf } = stage(
    '<div id="scroller"><div id="host"></div></div>',
    {
      '#scroller': {
        rect: { x: 0, y: 0, width: 100, height: 42 },
        style: { overflow: 'auto' },
      },
      '#host': STRIP,
    },
  );
  const host = nodeOf('#host');

  assert.deepEqual(scene.pseudoBounds(host, '::after'), {
    x: 0,
    y: 40,
    width: 100,
    height: 2,
  });
  assert.deepEqual(scene.bounds(host), { x: 0, y: 0, width: 100, height: 40 });
});

test('under zoom the pseudo-element is measured in content units', () => {
  // At scale 2 a CSS px is 2 viewport px. The host's viewport rect
  // (60, 40) 200×80, less the content's origin (20, 20), halves to content
  // (20, 10) 100×40; its strip, 4 CSS px tall, starts 40 CSS px below its top.
  const { scene, nodeOf } = stage(
    '<div id="host"></div>',
    { '#host': { ...STRIP, rect: { x: 60, y: 40, width: 200, height: 80 } } },
    { scale: 2, content: { x: 20, y: 20, width: 1600, height: 1200 } },
  );
  const host = nodeOf('#host');

  assert.deepEqual(scene.bounds(host), {
    x: 20,
    y: 10,
    width: 100,
    height: 40,
  });
  assert.deepEqual(scene.pseudoBounds(host, '::after'), {
    x: 20,
    y: 50,
    width: 100,
    height: 4,
  });
});

test('a point on the pseudo-element answers the pseudo, at an offset in its box', () => {
  const { scene, nodeOf } = strip();
  const host = nodeOf('#host');
  const onStrip = { x: 50, y: 42 };
  const onHost = { x: 50, y: 20 };

  assert.equal(pseudoAt(host, onStrip, scene.pseudoBounds), '::after');
  assert.equal(pseudoAt(host, onHost, scene.pseudoBounds), undefined);
  // Compared by id: a failure message inspecting the DOM element is unbounded.
  assert.equal(hitTest(scene.graph, onHost, scene.bounds)?.id, host.id);
  assert.deepEqual(
    offsetIn(
      targetBounds(
        { node: host, pseudo: '::after' },
        scene.bounds,
        scene.pseudoBounds,
      ),
      onStrip,
    ),
    { x: 0.5, y: 0.5 },
  );
});

test('where ::before and ::after share a box, the point answers ::after', () => {
  const { scene, nodeOf } = stage('<div id="host"></div>', {
    '#host': { ...STRIP, before: STRIP.after },
  });

  assert.equal(
    pseudoAt(nodeOf('#host'), { x: 50, y: 42 }, scene.pseudoBounds),
    '::after',
  );
});
