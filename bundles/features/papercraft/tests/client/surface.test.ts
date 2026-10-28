// `PreviewSurface`, mounted: every revision renders in a sandboxed iframe,
// and the surface speaks to it only over the frame protocol. The frame is a
// fake (`support/fake-frame.ts`) speaking the protocol over a real
// `MessageChannel`, as the preview runtime does.
//
// Contract matrix:
// - the iframe is `sandbox="allow-scripts"` only, and loads the platform's
//   frame document running this bundle's preview runtime;
// - a revision whose entries name no module renders its markup in the frame,
//   asks the cache for nothing and reports `markup` (no fallback notice);
// - a component preview keeps its origin stamp on the element the frame
//   rendered, so a click on it anchors to the component's file;
// - a named module the frame cannot load is replaced by the markup
//   (`fallback`);
// - a module that renders after it mounted reports the content it rendered;
// - the iframe is sized by the layout the frame reports: `centered` hugs the
//   reported width (up to the canvas's), the layouts that fill and an html
//   page take the canvas's width, a fallback hugs; the height is the
//   content's;
// - path B's route serves only what the cache verified: the frame is told
//   the module's URL (and its sheet's) only once the revision's entries are
//   cached; a revision that cannot be cached shows the markup (`fallback`);
// - a revision replaced while its entries were being cached is never told
//   its module, and the frame is disposed once when the surface goes;
// - the frame follows the app: its theme (live), the input capture, the
//   hidden layers, the cursor lock and each measure request;
// - the frame's word is untrusted: what does not parse, what comes before
//   its handshake and what does not come over its own port is dropped;
// - `ensureRevisionCached` hands the cache the bytes `artifacts/v1.read`
//   serves, scoped like every host call, and rejects when the module cannot
//   reach the cache (bytes gone, refused by the hash check, no scope).

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
type Previews = typeof import('../../src/host/previews.js');
type Anchor = typeof import('../../src/client/anchor.js');
type Data = typeof import('../../src/client/surface/preview-data.js');
type Graph = typeof import('../../src/client/surface/scene-graph.js');
type Protocol = typeof import('../../src/client/frame-protocol.js');
type FrameUrl = typeof import('../../src/client/frame-url.js');
type Memory = typeof import('../../src/client/surface/frame-memory.js');

let react: React;
let reactDomClient: ReactDomClient;
let surface: Surface;
let previews: Previews;
let anchor: Anchor;
let data: Data;
let graph: Graph;
let protocol: Protocol;
let frameUrl: FrameUrl;
let memory: Memory;

before(async () => {
  [
    react,
    reactDomClient,
    surface,
    previews,
    anchor,
    data,
    graph,
    protocol,
    frameUrl,
    memory,
  ] = await Promise.all([
    import('react'),
    import('react-dom/client'),
    import('../../src/client/surface/preview-surface.js'),
    import('../../src/host/previews.js'),
    import('../../src/client/anchor.js'),
    import('../../src/client/surface/preview-data.js'),
    import('../../src/client/surface/scene-graph.js'),
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

const AREA = { width: 800, height: 600 };

type Scene =
  readonly import('../../src/client/frame-protocol.js').SceneNodeData[];

const mount = (options: FakeOptions = {}) => {
  const frames = fakeFrames(window as never, options);
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
          artifactId: 'checkout-7f3a',
          revision: 1,
          markup: MARKUP,
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

const flush = () => react.act(delivered);

/** Messages of one kind the frame received, in order. */
const sentOf = <K extends string>(frame: FakeFrame, kind: K) =>
  frame.received.filter((message) => message.kind === kind) as Extract<
    (typeof frame.received)[number],
    { kind: K }
  >[];

test('every preview is a sandboxed frame running the bundle preview runtime', async () => {
  const m = mount();

  await m.render({ entries: ['index.html'] });
  await m.frame();

  const iframe = m.iframe();
  // Scripts, and nothing else: no same origin, so the frame's origin is
  // opaque and it reaches nothing of the app.
  assert.equal(iframe.getAttribute('sandbox'), 'allow-scripts');
  assert.equal(iframe.getAttribute('src'), frameUrl.previewFrameSrc());
  assert.match(
    decodeURIComponent(iframe.getAttribute('src') ?? ''),
    /^doric:\/\/app\/frame\/index\.html\?entry=.*\/frames\/preview\.js$/,
  );

  await m.unmount();
});

test('a revision without a module renders its markup and asks the cache for nothing', async () => {
  const m = mount();
  const ensured: unknown[] = [];

  await m.render({
    entries: ['index.html'],
    ensure: async (artifactId: string, revision: number) => {
      ensured.push([artifactId, revision]);
    },
  });
  const frame = await m.frame();

  assert.deepEqual(frame.init?.content, { kind: 'markup', markup: MARKUP });
  assert.deepEqual(ensured, []);
  assert.deepEqual(m.modes, ['markup']);
  // What the frame rendered reached the canvas as its scene.
  assert.ok(m.scenes.at(-1)?.some((node) => node.elementId === 'hi'));

  await m.unmount();
});

test('a component preview keeps its origin stamp on the element the frame rendered', async () => {
  const m = mount();
  const markup = previews.deriveMarkup(
    'component',
    'src/Checkout.tsx',
    'export const Checkout = () => <button />;',
  );

  await m.render({ markup, entries: ['index.html'] });
  await m.frame();

  const tree = graph.sceneGraphOf(m.scenes.at(-1) ?? []);
  const stamped = tree.nodes.find(
    (node) => node.source === 'src/Checkout.tsx:1',
  );
  assert.ok(
    stamped !== undefined,
    'the rendered scene lost the component stamp',
  );

  const clicked = anchor.anchorOf(stamped);
  assert.equal(clicked.form, 'source');
  assert.equal(clicked.path, 'src/Checkout.tsx');
  assert.equal(clicked.line, 1);

  await m.unmount();
});

test('a named module that does not load falls back to the markup', async () => {
  const m = mount({ module: () => ({ fails: true }) });

  await m.render({ entries: ['index.html', 'index.js'] });
  const frame = await m.frame();

  // The frame is handed the markup to stand in for the module.
  const content = frame.init?.content;
  assert.equal(content?.kind, 'module');
  assert.equal(content?.kind === 'module' ? content.fallback : '', MARKUP);
  assert.deepEqual(m.modes, ['fallback']);
  assert.equal(m.host().getAttribute('data-mode'), 'fallback');

  await m.unmount();
});

test('a module that renders after it mounted reports the content it rendered', async () => {
  const m = mount({ module: () => ({ mounts: '<main></main>' }) });

  await m.render({ entries: ['index.js'] });
  const frame = await m.frame();
  assert.deepEqual(m.modes, ['module']);

  // Like a React root: the element lands after the mount was reported.
  await react.act(async () => {
    frame.render('<main><p id="rendered">late</p></main>', 'module');
    await delivered();
  });

  assert.ok(
    m.scenes.at(-1)?.some((node) => node.elementId === 'rendered'),
    'the rendered element was never reported',
  );

  await m.unmount();
});

const widthOf = (iframe: HTMLIFrameElement) => iframe.style.width;
const heightOf = (iframe: HTMLIFrameElement) => iframe.style.height;

test('a component preview hugs its content unless its story asks to fill the canvas', async () => {
  const hugging = mount({
    module: () => ({ mounts: '<main></main>' }),
    size: { width: 320, height: 180 },
  });

  await hugging.render({ entries: ['index.html', 'index.js'] });
  await hugging.frame();
  assert.equal(hugging.host().getAttribute('data-layout'), 'centered');
  assert.equal(widthOf(hugging.iframe()), '320px');
  assert.equal(heightOf(hugging.iframe()), '180px');
  await hugging.unmount();

  // Wider than the canvas: it wraps at the canvas's width.
  const wide = mount({
    module: () => ({ mounts: '<main></main>' }),
    size: { width: 1200, height: 180 },
  });

  await wide.render({ entries: ['index.html', 'index.js'] });
  await wide.frame();
  assert.equal(widthOf(wide.iframe()), '800px');
  await wide.unmount();

  const filling = mount({
    module: () => ({ mounts: '<main></main>', layout: 'fullscreen' }),
    size: { width: 320, height: 900 },
  });

  await filling.render({ entries: ['index.html', 'index.js'] });
  await filling.frame();
  assert.equal(filling.host().getAttribute('data-layout'), 'fullscreen');
  assert.equal(widthOf(filling.iframe()), '800px');
  assert.equal(heightOf(filling.iframe()), '900px');
  await filling.unmount();

  // A component whose module did not load still hugs its fallback markup.
  const fallback = mount({
    module: () => ({ fails: true }),
    size: { width: 240, height: 100 },
  });

  await fallback.render({ entries: ['index.html', 'index.js'] });
  await fallback.frame();
  assert.equal(fallback.host().getAttribute('data-layout'), 'centered');
  assert.equal(widthOf(fallback.iframe()), '240px');
  await fallback.unmount();
});

test('an html revision fills the canvas, as the page it is', async () => {
  const m = mount({ size: { width: 300, height: 400 } });

  await m.render({ entries: ['index.html'] });
  await m.frame();

  assert.equal(m.host().getAttribute('data-layout'), 'fullscreen');
  assert.equal(widthOf(m.iframe()), '800px');
  assert.equal(heightOf(m.iframe()), '400px');

  await m.unmount();
});

test('a named module is handed to the frame only once its revision is cached', async () => {
  const m = mount({ module: () => ({ mounts: '<p>live</p>' }) });
  let cached: () => void = () => undefined;

  await m.render({
    entries: ['index.html', 'index.js', 'index.css'],
    ensure: () =>
      new Promise<void>((resolve) => {
        cached = resolve;
      }),
  });
  const connected = await m.frame((frame) => frame.connected);
  await flush();

  // Nothing is requested from the route before the cache holds it.
  assert.equal(connected.init, undefined);

  await react.act(async () => {
    cached();
    await delivered();
  });

  const frame = await m.frame();
  assert.deepEqual(frame.init?.content, {
    kind: 'module',
    module: surface.artifactModuleUrl('checkout-7f3a', 1),
    styles: surface.artifactStylesUrl('checkout-7f3a', 1),
    fallback: MARKUP,
  });
  assert.deepEqual(m.modes, ['module']);

  await m.unmount();
});

test('a revision that cannot be cached falls back to the markup', async () => {
  const m = mount();

  await m.render({
    entries: ['index.html', 'index.js'],
    ensure: async () => {
      throw new Error('hash_mismatch');
    },
  });
  const frame = await m.frame();

  // The module is never named: the route would serve nothing verified.
  assert.deepEqual(frame.init?.content, { kind: 'markup', markup: MARKUP });
  assert.deepEqual(m.modes, ['fallback']);
  assert.equal(m.host().getAttribute('data-layout'), 'centered');

  await m.unmount();
});

test('a revision replaced while it was being cached is never handed its module, and the live one is disposed once', async () => {
  const m = mount({ module: () => ({ mounts: '<p>live</p>' }) });
  let cacheFirst: () => void = () => undefined;

  // Revision 1 is still being cached when revision 2 replaces it.
  await m.render({
    revision: 1,
    entries: ['index.js'],
    ensure: (_id: string, revision: number) =>
      revision === 1
        ? new Promise<void>((resolve) => {
            cacheFirst = resolve;
          })
        : Promise.resolve(),
  });
  const first = await m.frame((frame) => frame.connected);

  await m.render({
    revision: 2,
    entries: ['index.js'],
    ensure: async () => undefined,
  });
  const second = await m.frame((frame) => frame !== first && frame.rendered);

  await react.act(async () => {
    cacheFirst();
    await delivered();
  });

  assert.equal(first.init, undefined);
  assert.equal(first.iframe.isConnected, false);
  const content = second.init?.content;
  assert.equal(
    content?.kind === 'module' ? content.module : undefined,
    surface.artifactModuleUrl('checkout-7f3a', 2),
  );

  await m.unmount();
  assert.equal(sentOf(second, 'dispose').length, 1);
  assert.equal(second.closed, true);
});

test('a frame shows only once it mounted, in the color scheme of the app theme', async () => {
  const m = mount({ auto: false });
  const root = document.documentElement;

  root.classList.add('dark');
  await m.render({ entries: ['index.html'] });
  const frame = await m.frame((candidate) => candidate.connected);
  // A document still loading paints its own canvas: white, under a dark app.
  assert.equal(frame.iframe.style.visibility, 'hidden');
  // The iframe's scheme matches the frame document's, so its canvas stays clear.
  assert.equal(frame.iframe.style.colorScheme, 'dark');

  await react.act(async () => {
    frame.ready();
    await delivered();
    frame.render('<p id="ok">ok</p>', 'markup');
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
  await m.render({ entries: ['index.html'] });
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

  await m.render({ entries: ['index.html'], capture: 'first' });
  const frame = await m.frame();
  assert.equal(frame.init?.capture, 'first');

  await m.render({
    entries: ['index.html'],
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
    entries: ['index.html'],
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

  await m.render({ entries: ['index.html'] });
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
  assert.equal(init()?.content.kind, 'markup');

  await react.act(async () => {
    // Malformed: an id the protocol does not allow, an unknown key, a
    // pointer with no point, an unknown kind, a newer protocol, a string.
    frame.post(scene('../n0'));
    frame.post({ ...scene('n1'), extra: true });
    frame.post({ kind: 'pointer', type: 'click' });
    frame.post({ kind: 'navigate', url: 'https://example.com' });
    frame.post({ kind: 'ready', protocol: 2 });
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

  await m.render({ entries: ['index.html'], revision: 7 });
  await m.frame();
  await m.unmount();

  const known = memory.lastFrameOf('checkout-7f3a', 7);
  assert.deepEqual(known?.size, { width: 300, height: 400 });
  assert.equal(known?.mode, 'markup');
  assert.ok(known?.scene?.some((node) => node.elementId === 'hi'));
  // The protocol's own schema accepts what was kept.
  assert.ok(protocol.frameMessage({ kind: 'scene', nodes: known?.scene }));
});

/* ensureRevisionCached ------------------------------------------------------ */

const MODULE_BYTES = Buffer.from('export const mount = () => {};').toString(
  'base64',
);

interface CacheHarness {
  readonly services: import('bundle/contracts').Services;
  readonly ensured: { input: unknown; scope: unknown }[];
}

const cacheHarness = (options: {
  readonly entries: readonly { path: string; base64?: string }[];
  readonly refused?: readonly string[];
}): CacheHarness => {
  const ensured: { input: unknown; scope: unknown }[] = [];
  const services = {
    use: (contract: { id?: string }, scope?: unknown) => {
      switch (contract.id) {
        case 'artifacts/v1':
          return {
            read: async (input: { artifactId: string; revision: number }) => ({
              artifactId: input.artifactId,
              revision: input.revision,
              entries: options.entries.map((entry) => ({
                sha256: 'a'.repeat(64),
                ...entry,
              })),
            }),
          };
        case 'artifacts.cache/v1':
          return {
            ensure: async (input: { entries: readonly { path: string }[] }) => {
              ensured.push({ input, scope });
              const failed = input.entries
                .filter((entry) => options.refused?.includes(entry.path))
                .map((entry) => ({
                  path: entry.path,
                  reason: 'hash_mismatch',
                  message: 'mismatch',
                }));

              return {
                kept: 0,
                written: input.entries.length - failed.length,
                failed,
              };
            },
          };
        default:
          throw new Error(`unexpected contract ${String(contract.id)}`);
      }
    },
  } as unknown as import('bundle/contracts').Services;

  return { services, ensured };
};

const SCOPE = { projectId: 'p1', threadId: 't-123' };

test('caching a revision hands the cache the bytes the host serves', async () => {
  const h = cacheHarness({
    entries: [
      { path: 'index.html', base64: 'PHA+PC9wPg==' },
      { path: 'index.js', base64: MODULE_BYTES },
      { path: 'index.css' },
    ],
  });

  await data.ensureRevisionCached(h.services, SCOPE, 'checkout-7f3a', 2);

  assert.equal(h.ensured.length, 1);
  const [{ input, scope }] = h.ensured as [
    {
      input: {
        artifactId: string;
        revision: number;
        entries: { path: string; base64: string }[];
      };
      scope: { projectId: string; threadId: string };
    },
  ];
  assert.equal(input.artifactId, 'checkout-7f3a');
  assert.equal(input.revision, 2);
  // An entry whose bytes the work copy no longer holds is not sent.
  assert.deepEqual(input.entries.map((entry) => entry.path).sort(), [
    'index.html',
    'index.js',
  ]);
  assert.equal(
    input.entries.find((entry) => entry.path === 'index.js')?.base64,
    MODULE_BYTES,
  );
  assert.equal(scope.projectId, 'p1');
  assert.equal(scope.threadId, 't-123');
});

test('caching a revision fails when its module cannot reach the cache', async () => {
  const gone = cacheHarness({ entries: [{ path: 'index.js' }] });
  await assert.rejects(
    data.ensureRevisionCached(gone.services, SCOPE, 'checkout-7f3a', 1),
  );

  const refused = cacheHarness({
    entries: [{ path: 'index.js', base64: MODULE_BYTES }],
    refused: ['index.js'],
  });
  await assert.rejects(
    data.ensureRevisionCached(refused.services, SCOPE, 'checkout-7f3a', 1),
  );

  const unscoped = cacheHarness({
    entries: [{ path: 'index.js', base64: MODULE_BYTES }],
  });
  await assert.rejects(
    data.ensureRevisionCached(unscoped.services, undefined, 'checkout-7f3a', 1),
  );
  assert.deepEqual(unscoped.ensured, []);
});
