// The preview frame's runtime, driven as the app drives it: a happy-dom
// window is the frame, the app's end of a real `MessageChannel` arrives with
// the `connect` window message, and every frame message must parse with the
// app's `frameMessage` (frame-protocol.ts). The revision is a fixture module
// imported for real (`support/frame-revision.ts`); layout is the one thing
// happy-dom does not compute, so boxes are stubbed where a case needs them.
//
// Contract matrix:
// - handshake: only the first well-formed `connect` with a port is the
//   channel, answered `ready`; app messages it does not understand are
//   dropped without breaking the channel;
// - module: mounted on `#root` with the theme on `<html>` before the mount,
//   the sheet linked, in-memory storage in place of a throwing one;
//   `mounted` states the mode and the root's layout;
// - a module that fails: the fallback markup, `centered`, with a
//   max-content width; without a fallback, an `error`;
// - markup (path A): rendered into the document with its styles and body
//   attributes, no script, `fullscreen`;
// - theme: switches `<html>` and mounts the revision again with it;
// - errors: the window's `error` and `unhandledrejection`, and the console's
//   `papercraft: …` render errors, become `error` messages;
// - scene: document order ids, parents, depths, own stamps, classes, ids,
//   collapsed and limited text, measured and clipped bounds, out-of-flow
//   pseudo boxes, the node limit, body portals, follows mutations;
// - hidden layers and the cursor lock;
// - capture `all` swallows and reports, `first` swallows the first press
//   only, `none` lets the preview handle input and still reports;
// - dispose unmounts the revision and empties the document.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  NODE_TEXT_LIMIT,
  PROTOCOL,
  SCENE_NODE_LIMIT,
  type SceneNodeData,
} from '../../src/client/frame-protocol.js';
import {
  connect,
  type Frame,
  fixtureLog,
  kind,
  type OpenOptions,
  openFrame,
  placeAt,
  revisionUrl,
} from './support/frame-harness.js';

const isMounted = kind('mounted');
const isScene = kind('scene');
const isSize = kind('size');
const isError = kind('error');
const isPointer = kind('pointer');

/** Runs `body` with a frame, closing it and checking every message parsed. */
const withFrame = async (
  body: (frame: Frame) => Promise<void>,
  options?: OpenOptions,
): Promise<void> => {
  const frame = await openFrame(options);

  try {
    await body(frame);
    assert.deepEqual(frame.invalid, [], 'every frame message parses');
  } finally {
    await frame.close();
  }
};

const initModule = (
  frame: Frame,
  content: Record<string, unknown> = {},
  rest: Record<string, unknown> = {},
) =>
  frame.send({
    kind: 'init',
    content: { kind: 'module', module: revisionUrl(), ...content },
    theme: 'light',
    capture: 'none',
    ...rest,
  });

/** A fresh scene, asked for with `measure` once earlier reports landed. */
const measure = async (frame: Frame): Promise<readonly SceneNodeData[]> => {
  await frame.settle();

  const from = frame.messages.length;

  frame.send({ kind: 'measure' });

  return (await frame.waitFor(isScene, from)).nodes;
};

const byElementId = (
  nodes: readonly SceneNodeData[],
  elementId: string,
): SceneNodeData => {
  const node = nodes.find((candidate) => candidate.elementId === elementId);

  assert.ok(node, `a node #${elementId}`);

  return node;
};

const element = (frame: Frame, id: string): HTMLElement => {
  const found = frame.document.getElementById(id);

  assert.ok(found, `#${id}`);

  return found;
};

type EventInit = Record<string, unknown>;

const dispatch = (
  frame: Frame,
  target: EventTarget,
  type: string,
  init: EventInit = {},
  eventClass = 'PointerEvent',
): Event => {
  const Constructor = (frame.win as unknown as Record<string, typeof Event>)[
    eventClass
  ] as unknown as new (
    type: string,
    init: EventInit,
  ) => Event;
  const event = new Constructor(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    ...init,
  });

  target.dispatchEvent(event);

  return event;
};

/* Handshake --------------------------------------------------------------- */

void test('only the first well-formed connect with a port becomes the channel', async () => {
  await withFrame(
    async (frame) => {
      const wrong = new MessageChannel();
      const late = new MessageChannel();
      const heard: unknown[] = [];

      wrong.port1.onmessage = (event) => heard.push(event.data);
      late.port1.onmessage = (event) => heard.push(event.data);

      try {
        // No port, another protocol, another kind: none is the channel.
        connect(frame);
        connect(frame, wrong.port2, {
          papercraft: PROTOCOL + 1,
          kind: 'connect',
        });
        connect(frame, wrong.port2, { papercraft: PROTOCOL, kind: 'hello' });
        await frame.settle();
        assert.deepEqual(heard, []);

        const real = new MessageChannel();
        const answers: unknown[] = [];

        real.port1.onmessage = (event) => answers.push(event.data);
        connect(frame, real.port2);
        connect(frame, late.port2);
        await frame.settle();

        assert.deepEqual(answers, [{ kind: 'ready', protocol: PROTOCOL }]);
        assert.deepEqual(heard, []);
        real.port1.close();
      } finally {
        wrong.port1.close();
        late.port1.close();
      }
    },
    { connect: false },
  );
});

void test('app messages the frame does not understand are dropped', async () => {
  await withFrame(async (frame) => {
    frame.send({ kind: 'teleport' });
    frame.send({ kind: 'theme', theme: 'sepia' });
    frame.send({ kind: 'hidden', ids: 'n1' });
    frame.send({ kind: 'init', content: { kind: 'module' } });
    await frame.settle();

    assert.equal(frame.messages.some(isMounted), false);

    initModule(frame);

    assert.equal((await frame.waitFor(isMounted)).mode, 'module');
  });
});

/* Rendering ------------------------------------------------------------ */

void test('a module mounts on #root with storage in memory and states its layout', async () => {
  await withFrame(
    async (frame) => {
      initModule(frame);

      const mounted = await frame.waitFor(isMounted);

      assert.deepEqual(
        { mode: mounted.mode, layout: mounted.layout },
        { mode: 'module', layout: 'centered' },
      );

      const root = element(frame, 'root');

      assert.equal(root.parentElement, frame.document.body);
      assert.ok(root.querySelector('#card'));
      assert.equal(
        root
          .querySelector('[data-papercraft-root]')
          ?.getAttribute('data-storage'),
        'stored',
      );

      const size = await frame.waitFor(isSize);

      assert.ok(size.width >= 0 && size.height >= 0);
    },
    {
      // An opaque origin's storage throws on access.
      before: (win) => {
        for (const name of ['localStorage', 'sessionStorage']) {
          Object.defineProperty(win, name, {
            configurable: true,
            get: () => {
              throw new Error('SecurityError: opaque origin');
            },
          });
        }
      },
    },
  );
});

void test('a module states padded or fullscreen on its root, and its sheet is linked', async () => {
  await withFrame(async (frame) => {
    initModule(frame, {
      module: revisionUrl('padded'),
      styles: 'https://frame.test/artifacts/a@1/index.css',
    });

    assert.equal((await frame.waitFor(isMounted)).layout, 'padded');

    const links = [
      ...frame.document.head.querySelectorAll('link[rel="stylesheet"]'),
    ].map((link) => link.getAttribute('href'));

    assert.deepEqual(links, ['https://frame.test/artifacts/a@1/index.css']);
  });
});

void test('a module that does not load hugs its fallback markup, measured at max-content', async () => {
  await withFrame(async (frame) => {
    const html = frame.document.documentElement;

    // The fallback is laid out to fit; at max-content it is 320px wide.
    (html as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect =
      () =>
        ({
          x: 0,
          y: 0,
          width: html.style.width === 'max-content' ? 320 : 180,
          height: 90,
        }) as DOMRect;

    initModule(frame, {
      module: new URL('./support/no-such-revision.js', import.meta.url).href,
      fallback:
        '<!doctype html><html><head><style>.note{color:red}</style></head><body class="note-page"><p id="note">Built markup</p></body></html>',
    });

    const mounted = await frame.waitFor(isMounted);

    assert.deepEqual(
      { mode: mounted.mode, layout: mounted.layout },
      { mode: 'fallback', layout: 'centered' },
    );
    assert.equal(element(frame, 'note').textContent, 'Built markup');
    assert.equal(frame.document.getElementById('root'), null);
    assert.deepEqual(
      { ...(await frame.waitFor(isSize)) },
      { kind: 'size', width: 320, height: 90 },
    );
  });
});

void test('a module that fails without a fallback reports an error', async () => {
  await withFrame(async (frame) => {
    initModule(frame, { module: revisionUrl('throws') });

    const error = await frame.waitFor(isError);

    assert.match(error.message, /mount exploded/);
    await frame.settle();
    assert.equal(frame.messages.some(isMounted), false);
  });
});

void test('markup renders into the document with its styles and body, and runs no script', async () => {
  await withFrame(async (frame) => {
    frame.send({
      kind: 'init',
      content: {
        kind: 'markup',
        markup:
          '<!doctype html><html><head><style>body { margin: 0 }</style><script>window.ranHead = true</script></head>' +
          '<body class="page" data-papercraft-source="index.html:1"><h1 id="title">Page</h1><script>window.ranBody = true</script></body></html>',
      },
      theme: 'light',
      capture: 'none',
    });

    const mounted = await frame.waitFor(isMounted);

    assert.deepEqual(
      { mode: mounted.mode, layout: mounted.layout },
      { mode: 'markup', layout: 'fullscreen' },
    );

    const { body, head } = frame.document;

    assert.equal(body.className, 'page');
    assert.equal(element(frame, 'title').textContent, 'Page');
    assert.equal(body.querySelector('script'), null);
    assert.ok(
      [...head.querySelectorAll('style')].some((style) =>
        style.textContent?.includes('margin: 0'),
      ),
    );

    const ran = frame.win as unknown as Record<string, unknown>;

    assert.equal(ran.ranHead, undefined);
    assert.equal(ran.ranBody, undefined);

    const nodes = (await frame.waitFor(isScene)).nodes;

    assert.deepEqual(
      nodes.map(({ tag, stamp }) => ({ tag, stamp })),
      [
        { tag: 'body', stamp: 'index.html:1' },
        { tag: 'h1', stamp: undefined },
      ],
    );
  });
});

/* Theme -------------------------------------------------------------------- */

void test('the theme is on <html> before the mount and a new theme mounts the revision again', async () => {
  await withFrame(async (frame) => {
    const html = frame.document.documentElement;

    initModule(frame, {}, { theme: 'dark' });
    await frame.waitFor(isMounted);

    assert.equal(html.classList.contains('dark'), true);
    assert.equal(html.getAttribute('data-papercraft-theme'), 'dark');
    // The iframe carries the same scheme, so its canvas is never painted opaque.
    assert.equal(html.style.colorScheme, 'dark');
    assert.equal(
      frame.document
        .querySelector('[data-papercraft-root]')
        ?.getAttribute('data-html-dark'),
      'true',
    );

    const from = frame.messages.length;

    frame.send({ kind: 'theme', theme: 'light' });
    await frame.waitFor(isMounted, from);

    assert.equal(html.classList.contains('dark'), false);
    assert.equal(html.getAttribute('data-papercraft-theme'), 'light');
    assert.equal(html.style.colorScheme, 'light');
    assert.deepEqual(fixtureLog(frame), {
      mounts: ['dark', 'light'],
      unmounts: 1,
    });
    assert.equal(
      frame.document
        .querySelectorAll('[data-papercraft-root]')
        .item(0)
        ?.getAttribute('data-theme'),
      'light',
    );
    assert.equal(frame.document.querySelectorAll('#card').length, 1);
  });
});

/* Errors ------------------------------------------------------------------- */

void test('the frame window errors and the revision render errors become error messages', async () => {
  await withFrame(async (frame) => {
    initModule(frame);
    await frame.waitFor(isMounted);

    const win = frame.win as unknown as {
      ErrorEvent: typeof ErrorEvent;
      Event: typeof Event;
      console: Console;
      dispatchEvent(event: Event): boolean;
    };
    let from = frame.messages.length;

    win.dispatchEvent(
      new win.ErrorEvent('error', {
        message: 'Uncaught TypeError: x is undefined',
        error: new TypeError('x is undefined'),
      }),
    );
    assert.match(
      (await frame.waitFor(isError, from)).message,
      /x is undefined/,
    );

    // The browser's ResizeObserver loop notice is no failure of the preview.
    from = frame.messages.length;
    win.dispatchEvent(
      new win.ErrorEvent('error', {
        message:
          'ResizeObserver loop completed with undelivered notifications.',
      }),
    );
    await frame.settle();
    assert.equal(frame.messages.slice(from).filter(isError).length, 0);

    from = frame.messages.length;

    const rejection = new win.Event('unhandledrejection');

    Object.defineProperty(rejection, 'reason', { value: new Error('lost') });
    win.dispatchEvent(rejection);
    assert.match((await frame.waitFor(isError, from)).message, /lost/);

    from = frame.messages.length;
    win.console.error('an unrelated warning');
    win.console.error(
      'papercraft: a render error in https://frame.test/index.js',
      new Error('Card broke'),
      '\n    at Card',
    );

    const rendered = await frame.waitFor(isError, from);

    assert.match(rendered.message, /Card broke/);
    assert.match(rendered.stack ?? '', /at Card/);
    await frame.settle();
    assert.equal(frame.messages.slice(from).filter(isError).length, 1);
  });
});

/* Scene -------------------------------------------------------------------- */

void test('the scene serializes the rendered tree in document order', async () => {
  await withFrame(async (frame) => {
    initModule(frame);
    await frame.waitFor(isMounted);

    const nodes = await measure(frame);

    assert.deepEqual(
      nodes.map((node) => node.id),
      nodes.map((_node, index) => `n${String(index)}`),
    );

    const card = byElementId(nodes, 'card');
    const heading = nodes.find((node) => node.tag === 'h1');
    const button = byElementId(nodes, 'button');
    const long = byElementId(nodes, 'long');

    assert.ok(heading);
    assert.deepEqual(
      {
        tag: card.tag,
        classes: card.classes,
        stamp: card.stamp,
        depth: card.depth,
      },
      {
        tag: 'main',
        classes: ['card', 'shadow'],
        stamp: 'src/Card.tsx:3',
        depth: 1,
      },
    );
    assert.equal(heading.parentId, card.id);
    assert.equal(heading.depth, 2);
    assert.equal(heading.text, 'Hello world');
    // A node carries its own stamp only: the app walks it down.
    assert.equal(button.stamp, undefined);
    // Its leading whitespace collapsed away, then cut at the limit.
    assert.equal(long.text, 'w'.repeat(NODE_TEXT_LIMIT));
  });
});

void test('bounds are the measured boxes in frame px, cut by clipping ancestors', async () => {
  await withFrame(async (frame) => {
    initModule(frame);
    await frame.waitFor(isMounted);

    const card = element(frame, 'card');
    const heading = card.querySelector('h1');

    card.style.overflowX = 'hidden';
    card.style.overflowY = 'hidden';
    placeAt(card, { x: 0, y: 0, width: 100, height: 50 });
    placeAt(heading, { x: 50, y: 25, width: 100, height: 100 });
    placeAt(element(frame, 'link'), { x: 10, y: 60, width: 20, height: 10 });

    const nodes = await measure(frame);

    assert.deepEqual(byElementId(nodes, 'card').bounds, {
      x: 0,
      y: 0,
      width: 100,
      height: 50,
    });
    assert.deepEqual(nodes.find((node) => node.tag === 'h1')?.bounds, {
      x: 50,
      y: 25,
      width: 50,
      height: 25,
    });
    // Clipped out of sight: it keeps its place and takes no room.
    assert.deepEqual(byElementId(nodes, 'link').bounds, {
      x: 10,
      y: 60,
      width: 0,
      height: 0,
    });
  });
});

void test('an out-of-flow pseudo-element is its own box and the pointer can land on it', async () => {
  await withFrame(async (frame) => {
    initModule(frame);
    await frame.waitFor(isMounted);

    const button = element(frame, 'button');
    const win = frame.win as unknown as {
      getComputedStyle: (element: Element, pseudo?: string | null) => unknown;
    };
    const real = win.getComputedStyle.bind(win);

    // A badge: `button::after { content: ''; position: absolute; … }`.
    win.getComputedStyle = (target, pseudo) => {
      if (target !== button) return real(target, pseudo);
      if (pseudo === '::after') {
        return {
          content: '""',
          position: 'absolute',
          left: '90px',
          top: '-6px',
          right: '-14px',
          bottom: '30px',
          marginLeft: '0px',
          marginTop: '0px',
          marginRight: '0px',
          marginBottom: '0px',
        };
      }

      return pseudo
        ? { content: 'none', position: 'static' }
        : {
            ...(real(target) as object),
            position: 'relative',
          };
    };
    placeAt(button, { x: 0, y: 0, width: 100, height: 40 });

    const nodes = await measure(frame);

    assert.deepEqual(byElementId(nodes, 'button').pseudo, {
      '::after': { x: 90, y: -6, width: 24, height: 16 },
    });

    frame.send({ kind: 'capture', capture: 'all' });
    await frame.settle();

    const from = frame.messages.length;

    dispatch(
      frame,
      button,
      'click',
      { clientX: 100, clientY: 0 },
      'MouseEvent',
    );

    const pointer = await frame.waitFor(isPointer, from);

    assert.deepEqual(
      { nodeId: pointer.nodeId, pseudo: pointer.pseudo },
      { nodeId: byElementId(nodes, 'button').id, pseudo: '::after' },
    );
  });
});

void test('a scene carries at most SCENE_NODE_LIMIT nodes', async () => {
  await withFrame(async (frame) => {
    initModule(frame, { module: revisionUrl('many') });
    await frame.waitFor(isMounted);

    assert.equal((await measure(frame)).length, SCENE_NODE_LIMIT);
  });
});

void test('overlays portaled into the body are in the scene after the root tree', async () => {
  await withFrame(async (frame) => {
    initModule(frame, { module: revisionUrl('portal') });
    await frame.waitFor(isMounted);

    const nodes = await measure(frame);
    const overlay = byElementId(nodes, 'overlay');

    assert.deepEqual(
      { depth: overlay.depth, stamp: overlay.stamp, text: overlay.text },
      { depth: 0, stamp: 'src/Overlay.tsx:7', text: 'open' },
    );
    assert.equal(overlay.id, nodes.at(-1)?.id);
    assert.equal(
      nodes.some((node) => node.elementId === 'root'),
      false,
    );
  });
});

void test('the scene follows what the preview renders next', async () => {
  await withFrame(async (frame) => {
    initModule(frame);
    await frame.waitFor(isMounted);
    await frame.waitFor(isScene);

    const from = frame.messages.length;
    const added = frame.document.createElement('section');

    added.id = 'opened';
    element(frame, 'card').append(added);

    const next = await frame.waitFor(
      (message): message is Extract<typeof message, { kind: 'scene' }> =>
        isScene(message) &&
        message.nodes.some((node) => node.elementId === 'opened'),
      from,
    );

    assert.ok(next);
  });
});

/* View state ---------------------------------------------------------------- */

void test('hidden layers hide the listed nodes of the last scene, and [] shows all', async () => {
  await withFrame(async (frame) => {
    initModule(frame);
    await frame.waitFor(isMounted);

    const nodes = await measure(frame);
    const card = element(frame, 'card');
    const link = element(frame, 'link');

    frame.send({ kind: 'hidden', ids: [byElementId(nodes, 'link').id] });
    await frame.settle();

    assert.equal(link.style.visibility, 'hidden');
    assert.equal(card.style.visibility, '');

    frame.send({ kind: 'hidden', ids: [] });
    await frame.settle();

    assert.equal(link.style.visibility, '');
  });
});

void test('a locked cursor is the canvas cursor over every element of the preview', async () => {
  await withFrame(async (frame) => {
    initModule(frame);
    await frame.waitFor(isMounted);

    const sheets = () =>
      [...frame.document.head.querySelectorAll('style')]
        .map((style) => style.textContent ?? '')
        .join('\n');

    frame.send({ kind: 'cursor', locked: true, cursor: 'crosshair' });
    await frame.settle();
    assert.match(sheets(), /html \{ cursor: crosshair !important; \}/);
    assert.match(sheets(), /\* \{ cursor: inherit !important; \}/);

    frame.send({ kind: 'cursor', locked: true, cursor: 'url(evil), auto' });
    await frame.settle();
    assert.doesNotMatch(sheets(), /evil/);

    frame.send({ kind: 'cursor', locked: false });
    await frame.settle();
    assert.doesNotMatch(sheets(), /cursor/);
  });
});

/* Input capture ------------------------------------------------------------- */

void test('capture all keeps every click from the preview and reports it with its node', async () => {
  await withFrame(async (frame) => {
    initModule(frame, {}, { capture: 'all' });
    await frame.waitFor(isMounted);

    const nodes = await measure(frame);
    const link = element(frame, 'link');
    let reached = 0;

    link.addEventListener('click', () => {
      reached += 1;
    });
    link.addEventListener('pointerdown', () => {
      reached += 1;
    });

    const from = frame.messages.length;
    const down = dispatch(frame, link, 'pointerdown', {
      clientX: 12,
      clientY: 64,
      buttons: 1,
    });
    const click = dispatch(
      frame,
      link,
      'click',
      { clientX: 12, clientY: 64 },
      'MouseEvent',
    );

    assert.equal(reached, 0);
    assert.equal(down.defaultPrevented, true);
    // The link never navigates.
    assert.equal(click.defaultPrevented, true);

    await frame.settle();

    const pointers = frame.messages.slice(from).filter(isPointer);
    const linkId = byElementId(nodes, 'link').id;

    assert.deepEqual(
      pointers.map(({ type, nodeId, point }) => ({ type, nodeId, point })),
      [
        { type: 'down', nodeId: linkId, point: { x: 12, y: 64 } },
        { type: 'click', nodeId: linkId, point: { x: 12, y: 64 } },
      ],
    );
  });
});

void test('capture all reports the wheel, the canvas keys and the pointer leaving', async () => {
  await withFrame(async (frame) => {
    initModule(frame, {}, { capture: 'all' });
    await frame.waitFor(isMounted);

    const body = frame.document.body;
    const from = frame.messages.length;
    const wheel = dispatch(
      frame,
      body,
      'wheel',
      { deltaY: 40, clientX: 3, clientY: 4 },
      'WheelEvent',
    );

    assert.equal(wheel.defaultPrevented, true);

    dispatch(
      frame,
      body,
      'keydown',
      { key: ' ', code: 'Space' },
      'KeyboardEvent',
    );
    dispatch(
      frame,
      body,
      'keydown',
      { key: 'x', code: 'KeyX' },
      'KeyboardEvent',
    );
    dispatch(
      frame,
      body,
      'keyup',
      { key: ' ', code: 'Space' },
      'KeyboardEvent',
    );
    dispatch(frame, body, 'pointerout', { relatedTarget: null });
    await frame.settle();

    const reported = frame.messages
      .slice(from)
      .map((message) =>
        message.kind === 'wheel'
          ? `wheel ${String(message.deltaY)}`
          : message.kind === 'key'
            ? `${message.type} ${message.code}`
            : message.kind === 'pointer'
              ? `pointer ${message.type}`
              : undefined,
      )
      .filter((entry) => entry !== undefined);

    assert.deepEqual(reported, [
      'wheel 40',
      'keydown Space',
      'keyup Space',
      'pointer leave',
    ]);
  });
});

void test('capture first keeps only the first press from the preview', async () => {
  await withFrame(async (frame) => {
    initModule(frame, {}, { capture: 'first' });
    await frame.waitFor(isMounted);

    const button = element(frame, 'button');
    let clicks = 0;

    button.addEventListener('click', () => {
      clicks += 1;
    });

    const from = frame.messages.length;

    dispatch(frame, button, 'pointerdown', { buttons: 1 });
    dispatch(frame, button, 'pointerup');
    dispatch(frame, button, 'click', {}, 'MouseEvent');
    assert.equal(clicks, 0);

    await frame.settle();
    assert.deepEqual(
      frame.messages
        .slice(from)
        .filter(isPointer)
        .map((pointer) => pointer.type),
      ['down', 'up', 'click'],
    );

    dispatch(frame, button, 'pointerdown', { buttons: 1 });
    dispatch(frame, button, 'pointerup');
    dispatch(frame, button, 'click', {}, 'MouseEvent');
    assert.equal(clicks, 1);
  });
});

void test('capture none lets the preview handle its input and still reports the pointer', async () => {
  await withFrame(async (frame) => {
    initModule(frame);
    await frame.waitFor(isMounted);

    const nodes = await measure(frame);
    const button = element(frame, 'button');
    let clicks = 0;

    button.addEventListener('click', () => {
      clicks += 1;
    });

    const from = frame.messages.length;
    const click = dispatch(frame, button, 'click', {}, 'MouseEvent');

    assert.equal(clicks, 1);
    assert.equal(click.defaultPrevented, false);
    assert.equal(
      (await frame.waitFor(isPointer, from)).nodeId,
      byElementId(nodes, 'button').id,
    );
  });
});

/* Dispose -------------------------------------------------------------------- */

void test('dispose unmounts the revision and empties the document', async () => {
  await withFrame(async (frame) => {
    initModule(frame, {
      module: revisionUrl('portal'),
      styles: 'https://frame.test/a.css',
    });
    await frame.waitFor(isMounted);

    frame.send({ kind: 'dispose' });
    await frame.settle();

    assert.equal(fixtureLog(frame).unmounts, 1);
    assert.equal(frame.document.body.children.length, 0);
    assert.equal(frame.document.head.querySelectorAll('link, style').length, 0);

    const from = frame.messages.length;

    frame.send({ kind: 'measure' });
    await frame.settle();
    assert.deepEqual(frame.messages.slice(from), []);
  });
});
