// `PreviewSurface`, mounted: every program renders in a sandboxed iframe,
// and the surface speaks to it only over the frame protocol (2, D6). The
// frame is a fake (`support/fake-frame.ts`) speaking the protocol over a real
// `MessageChannel`, as the program runtime does.
//
// Contract matrix:
// - the iframe is `sandbox="allow-scripts"` only, and loads the platform's
//   frame document running this bundle's program runtime;
// - the frame follows the app: its theme (live), the input capture, the
//   hidden layers, the cursor lock and each measure request;
// - the frame's word is untrusted: what does not parse, what comes before
//   its handshake and what does not come over its own port is dropped.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { Window } from 'happy-dom';
import { createElement } from 'react';

import {
  delivered,
  type FakeFrame,
  type FakeOptions,
  fakeFrames,
} from './support/fake-frame.js';

const window = new Window({ settings: { disableIframePageLoading: true } });

for (const name of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'HTMLIFrameElement',
  'Element',
  'Node',
  'Event',
  'CustomEvent',
  'customElements',
  'DOMParser',
  'MutationObserver',
] as const) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: window[name as keyof Window],
    writable: true,
  });
}

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type React = typeof import('react');
type ReactDomClient = typeof import('react-dom/client');
type Surface = typeof import('../../src/client/surface/preview-surface.js');
type Protocol = typeof import('../../src/client/frame-protocol.js');
type Memory = typeof import('../../src/client/surface/frame-memory.js');
type FrameUrl = typeof import('../../src/client/frame-url.js');

let react: React;
let reactDomClient: ReactDomClient;
let surface: Surface;
let protocol: Protocol;
let memory: Memory;
let frameUrl: FrameUrl;

before(async () => {
  [react, reactDomClient, surface, protocol, frameUrl, memory] =
    await Promise.all([
      import('react'),
      import('react-dom/client'),
      import('../../src/client/surface/preview-surface.js'),
      import('../../src/client/frame-protocol.js'),
      import('../../src/client/frame-url.js'),
      import('../../src/client/surface/frame-memory.js'),
    ]);
});

after(async () => {
  await window.happyDOM.abort();
  await window.happyDOM.close();
});

const MARKUP =
  '<!DOCTYPE html><html><head><style>p{}</style></head><body><p id="hi">oi</p></body></html>';

/** The program the surface hands its frame; the fake frame renders `MARKUP` for it. */
const PROGRAM = {
  init: {},
  message: { text: 'root = TextContent("oi")', streaming: false, exports: {} },
};

const AREA = { width: 800, height: 600 };

type Scene =
  readonly import('../../src/client/frame-protocol.js').SceneNodeData[];

const mount = (options: FakeOptions = {}) => {
  const frames = fakeFrames(window as never, {
    program: () => MARKUP,
    ...options,
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = reactDomClient.createRoot(host);
  const modes: string[] = [];
  const scenes: (Scene | undefined)[] = [];
  const inputs: unknown[] = [];

  const render = async (props: Record<string, unknown>) => {
    await react.act(async () => {
      root.render(
        createElement(surface.PreviewSurface, {
          canvasId: 'checkout-7f3a',
          revision: 1,
          program: PROGRAM,
          area: AREA,
          onMode: (mode: string) => modes.push(mode),
          onScene: (nodes: Scene | undefined) => scenes.push(nodes),
          onInput: (message: unknown) => inputs.push(message),
          ...props,
        } as never),
      );
      await delivered();
    });
  };

  /** The live frame of the surface, once it rendered what it was told. */
  const frame = async (
    holds?: (frame: FakeFrame) => boolean,
  ): Promise<FakeFrame> => {
    let found: FakeFrame | undefined;

    // What the frame said reaches the surface a delivery later.
    await react.act(async () => {
      found = await frames.next(host, holds);
      await delivered();
    });
    assert.ok(found !== undefined);

    return found;
  };

  const iframe = (): HTMLIFrameElement => {
    const found = host.querySelector('iframe');
    assert.ok(found !== null, 'the surface holds no iframe');

    return found as unknown as HTMLIFrameElement;
  };

  return {
    render,
    frame,
    iframe,
    modes,
    scenes,
    inputs,
    host: () => host.querySelector('.papercraft-surface-host') as HTMLElement,
    unmount: async () => {
      await react.act(async () => {
        root.unmount();
        // What the surface told the frame as it went reaches the frame.
        await delivered();
      });
      frames.dispose();
      host.remove();
    },
  };
};

/** Messages of one kind the frame received, in order. */
const sentOf = <K extends string>(frame: FakeFrame, kind: K) =>
  frame.received.filter((message) => message.kind === kind) as Extract<
    (typeof frame.received)[number],
    { kind: K }
  >[];

test('every program is a sandboxed frame running the bundle program runtime', async () => {
  const m = mount();

  await m.render({});
  await m.frame();

  const iframe = m.iframe();
  // Scripts, and nothing else: no same origin, so the frame's origin is
  // opaque and it reaches nothing of the app.
  assert.equal(iframe.getAttribute('sandbox'), 'allow-scripts');
  assert.equal(iframe.getAttribute('src'), frameUrl.programFrameSrc());
  assert.match(
    decodeURIComponent(iframe.getAttribute('src') ?? ''),
    /^doric:\/\/app\/frame\/index\.html\?entry=.*\/frames\/openui\.js$/,
  );

  await m.unmount();
});

test('a frame shows only once it mounted, in the color scheme of the app theme', async () => {
  const m = mount({ auto: false });
  const root = document.documentElement;

  root.classList.add('dark');
  await m.render({});
  const frame = await m.frame((candidate) => candidate.connected);
  // A document still loading paints its own canvas: white, under a dark app.
  assert.equal(frame.iframe.style.visibility, 'hidden');
  // The iframe's scheme matches the frame document's, so its canvas stays clear.
  assert.equal(frame.iframe.style.colorScheme, 'dark');

  await react.act(async () => {
    frame.ready();
    await delivered();
    frame.render('<p id="ok">ok</p>', 'module');
    await delivered();
  });
  assert.notEqual(frame.iframe.style.visibility, 'hidden');

  await react.act(async () => {
    root.classList.remove('dark');
    await delivered();
  });
  assert.equal(frame.iframe.style.colorScheme, 'light');

  await m.unmount();
});

test('the frame follows the app theme live', async () => {
  const m = mount();
  const root = document.documentElement;

  root.classList.remove('dark');
  await m.render({});
  const frame = await m.frame();
  assert.equal(frame.init?.theme, 'light');

  await react.act(async () => {
    root.classList.add('dark');
    await delivered();
  });
  assert.deepEqual(
    sentOf(frame, 'theme').map((message) => message.theme),
    ['dark'],
  );

  await react.act(async () => {
    root.classList.remove('dark');
    await delivered();
  });
  assert.deepEqual(
    sentOf(frame, 'theme').map((message) => message.theme),
    ['dark', 'light'],
  );

  await m.unmount();
});

test('the frame is told who handles its input, what to hide, the cursor and when to measure', async () => {
  const m = mount();

  await m.render({ capture: 'first' });
  const frame = await m.frame();
  assert.equal(frame.init?.capture, 'first');

  await m.render({
    capture: 'all',
    hidden: new Set(['n1']),
    cursor: { locked: true, cursor: 'crosshair' },
    measureRequest: 1,
  });

  assert.deepEqual(
    sentOf(frame, 'capture').map((message) => message.capture),
    ['all'],
  );
  assert.deepEqual(
    sentOf(frame, 'hidden').map((message) => message.ids),
    [['n1']],
  );
  assert.deepEqual(sentOf(frame, 'cursor'), [
    { kind: 'cursor', locked: true, cursor: 'crosshair' },
  ]);
  assert.equal(sentOf(frame, 'measure').length, 1);

  // The same props again tell the frame nothing new; showing all is `[]`.
  await m.render({
    capture: 'all',
    hidden: new Set(),
    cursor: { locked: false },
    measureRequest: 1,
  });
  assert.equal(sentOf(frame, 'capture').length, 1);
  assert.deepEqual(
    sentOf(frame, 'hidden').map((message) => message.ids),
    [['n1'], []],
  );
  assert.deepEqual(sentOf(frame, 'cursor').at(-1), {
    kind: 'cursor',
    locked: false,
  });
  assert.equal(sentOf(frame, 'measure').length, 1);

  await m.unmount();
});

test('the frame word is dropped when it does not parse, comes before its handshake or off its port', async () => {
  const m = mount({ auto: false });

  await m.render({});
  const frame = await m.frame((candidate) => candidate.connected);
  const scene = (id: string) => ({
    kind: 'scene',
    nodes: [
      {
        id,
        depth: 0,
        tag: 'p',
        classes: [],
        text: '',
        bounds: { x: 0, y: 0, width: 1, height: 1 },
      },
    ],
  });

  const scenes = () => m.scenes.map((nodes) => nodes?.map((node) => node.id));
  const inputs = () => m.inputs.length;
  const init = () => frame.init;

  // Before `ready`, even a valid message is not the frame's yet.
  await react.act(async () => {
    frame.post(scene('n0'));
    await delivered();
  });
  assert.deepEqual(scenes(), []);
  assert.equal(init(), undefined);

  await react.act(async () => {
    frame.ready();
    await delivered();
  });
  assert.notEqual(init(), undefined);

  await react.act(async () => {
    // Malformed: an id the protocol does not allow, an unknown key, a
    // pointer with no point, an unknown kind, a newer protocol, a string.
    frame.post(scene('../n0'));
    frame.post({ ...scene('n1'), extra: true });
    frame.post({ kind: 'pointer', type: 'click' });
    frame.post({ kind: 'navigate', url: 'https://example.com' });
    frame.post({ kind: 'ready', protocol: 3 });
    frame.post('<p>');
    // Off the channel: the app's window is no way in.
    window.postMessage(scene('n2'), '*');
    await delivered();
  });
  assert.deepEqual(scenes(), []);
  assert.equal(inputs(), 0);

  await react.act(async () => {
    frame.post(scene('n3'));
    await delivered();
  });
  assert.deepEqual(scenes(), [['n3']]);

  await m.unmount();
});

test('what the frame reported stays known for its revision after it goes', async () => {
  const m = mount({ size: { width: 300, height: 400 } });

  await m.render({ revision: 7 });
  await m.frame();
  await m.unmount();

  const known = memory.lastFrameOf('checkout-7f3a', 7);
  assert.deepEqual(known?.size, { width: 300, height: 400 });
  assert.equal(known?.mode, 'module');
  assert.ok(known?.scene?.some((node) => node.elementId === 'hi'));
  // The protocol's own schema accepts what was kept.
  assert.ok(protocol.frameMessage({ kind: 'scene', nodes: known?.scene }));
});
