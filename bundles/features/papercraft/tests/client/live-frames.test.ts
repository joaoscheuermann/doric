// The window's live frames, as the conversation mounts its previews
// (isolamento.md, "Virtualização"): a window keeps at most three live frames,
// the previews used most recently; the others draw their snapshot, or a
// placeholder, with the pins of the last scene their frame reported. The
// frames are fakes speaking the frame protocol (`support/fake-frame.ts`), the
// window's capture is a fake `papercraft.snapshot/v1`, and what is on screen
// is told by a fake `IntersectionObserver`.
//
// Contract matrix:
// - a fourth preview appearing takes the live frame of the least recently
//   used one, which draws its stand-in instead;
// - a dead preview scrolled into view stays dead; the pointer over it
//   promotes it, and the least recently used live one dies;
// - a live preview on screen is in use: a new one evicts a live preview out
//   of view before it;
// - a dead preview draws its snapshot with the pins its last scene placed,
//   also when the conversation mounts it again;
// - a promoted preview keeps its snapshot over the new frame until the frame
//   says it mounted;
// - a node's expanded modal is live outside the count, and the nodes stay
//   live.

import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';

import type { Services } from 'bundle/contracts';
import { Window } from 'happy-dom';
import { createElement } from 'react';

import {
  delivered,
  type FakeOptions,
  fakeFrames,
} from './support/fake-frame.js';
import { fakeIntersection } from './support/fake-intersection.js';

const window = new Window({ settings: { disableIframePageLoading: true } });

for (const name of [
  'window',
  'document',
  'location',
  'navigator',
  'HTMLElement',
  'Element',
  'Node',
  'Event',
  'CustomEvent',
  'customElements',
  'DOMParser',
] as const) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: window[name as keyof Window],
    writable: true,
  });
}

// The node's modal (base-ui's dialog) measures its popup and schedules its
// open and close transitions on animation frames.
for (const name of [
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
] as const) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: window[name].bind(window),
    writable: true,
  });
}

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type React = typeof import('react');
type ReactDomClient = typeof import('react-dom/client');
type Container = typeof import('../../src/client/surface/preview-container.js');

let react: React;
let reactDomClient: ReactDomClient;
let PreviewContainer: Container['PreviewContainer'];

const intersection = fakeIntersection();

before(async () => {
  [react, reactDomClient] = await Promise.all([
    import('react'),
    import('react-dom/client'),
  ]);
  PreviewContainer = (
    await import('../../src/client/surface/preview-container.js')
  ).PreviewContainer;
});

// happy-dom lays nothing out: the canvas of every preview measures as a
// conversation's node would.
for (const [property, value] of [
  ['clientWidth', 640],
  ['clientHeight', 640],
] as const) {
  Object.defineProperty(window.HTMLElement.prototype, property, {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('papercraft-canvas') ? value : 0;
    },
  });
}

/** How the fake frames behave; a test may change it for the frames to come. */
const frameOptions: {
  auto?: boolean;
  layout?: FakeOptions['layout'];
  size?: FakeOptions['size'];
} = {
  layout: { '#pay': { box: { x: 40, y: 60, width: 120, height: 32 } } },
  size: { width: 640, height: 300 },
};
const frames = fakeFrames(window as never, frameOptions);

after(async () => {
  frames.dispose();
  intersection.restore();
  await window.happyDOM.abort();
  await window.happyDOM.close();
});

const MARKUP = [
  '<!DOCTYPE html><html><head></head><body>',
  '<h1 id="title" data-papercraft-source="src/checkout.html:12">Checkout</h1>',
  '<button id="pay" data-papercraft-source="src/checkout.html:42">Pagar</button>',
  '</body></html>',
].join('');

/** The PNG the fake capture answers, as base64. */
const PNG = 'iVBORw0KGgo=';

/** Polls until `read()` holds, letting React commit between reads. */
const settle = async <T>(
  read: () => T,
  holds: (value: T) => boolean,
  message: string,
  attempts = 500,
): Promise<T> => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = read();

    if (holds(value)) return value;

    await react.act(async () => {
      await new Promise((done) => setTimeout(done, 10));
    });
  }

  throw new Error(message);
};

let runs = 0;

/** The windows of the tests, closed after each, should a test fail first. */
const windows: { close(): Promise<void> }[] = [];

afterEach(async () => {
  for (const opened of windows.splice(0)) await opened.close();
  delete frameOptions.auto;
});

/**
 * A window's services for one test: its previews (`html` revisions of the
 * same markup), one durable comment pinned on the pay button of each, and
 * the window's capture.
 */
const windowOf = () => {
  runs += 1;
  const prefix = `run${String(runs)}`;
  const captures: { rect: unknown }[] = [];
  const capture = { fails: false };

  const services = {
    provide: () => ({ dispose: () => undefined }),
    whenAvailable: () => ({ dispose: () => undefined }),
    use: (contract: { id?: string }) => {
      switch (contract.id) {
        case 'artifacts/v1':
          return {
            read: async (input: { artifactId: string }) => ({
              artifactId: input.artifactId,
              kind: 'preview',
              title: `Checkout ${input.artifactId}`,
              revision: 1,
              revisions: 1,
              targets: [{ path: 'src/checkout.html' }],
              source: 'html',
              path: `${input.artifactId}.html`,
              state: 'open',
              createdAt: '2024-01-01T00:00:00Z',
            }),
            policy: async () => ({ policy: 'proceed' }),
          };
        case 'papercraft.previews/v1':
          return {
            read: async (input: { artifactId: string; revision: number }) => ({
              artifactId: input.artifactId,
              revision: input.revision,
              kind: 'preview',
              files: [{ path: 'index.html', sha256: 'abc' }],
              markup: MARKUP,
            }),
          };
        case 'comments/v1':
          return {
            list: async (input: { target?: { id?: string } }) =>
              ['a', 'b', 'c', 'd', 'open']
                .map((name) => `${prefix}-${name}`)
                .map((id) => ({
                  commentId: `c-${id}`,
                  target: {
                    kind: 'artifact',
                    id,
                    revision: 1,
                    anchor: {
                      form: 'source',
                      path: 'src/checkout.html',
                      line: 42,
                    },
                  },
                  text: 'mais respiro',
                  resolved: false,
                  createdAt: '2024-01-01T00:00:00Z',
                }))
                .filter(
                  (comment) =>
                    input.target?.id === undefined ||
                    comment.target.id === input.target.id,
                ),
          };
        case 'papercraft.snapshot/v1':
          return {
            capture: async (input: { rect: unknown }) => {
              captures.push(input);
              if (capture.fails) throw new Error('unavailable');

              return { png: PNG, width: 400, height: 200, scale: 2 };
            },
          };
        default:
          throw new Error(`unexpected contract ${String(contract.id)}`);
      }
    },
  } as unknown as Services;

  const mounted: (() => Promise<void>)[] = [];

  /** Mounts one preview of the window, as the conversation does. */
  const mount = async (
    name: string,
    chrome: 'node' | 'canvas' = 'node',
  ): Promise<Preview> => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = reactDomClient.createRoot(host);
    const artifactId = `${prefix}-${name}`;

    await react.act(async () => {
      root.render(
        createElement(PreviewContainer, {
          services,
          chrome,
          scope: { projectId: 'p1', threadId: 't1' },
          artifactId,
          ...(chrome === 'node' ? { blockRevision: 1 } : {}),
        }),
      );
      await delivered();
    });

    let gone = false;
    const unmount = async () => {
      if (gone) return;
      gone = true;
      await react.act(async () => {
        root.unmount();
        await delivered();
      });
      host.remove();
    };

    mounted.push(unmount);

    return previewIn(host, unmount);
  };

  const opened = {
    mount,
    captures,
    capture,
    /** Unmounts every preview the test mounted. */
    close: async () => {
      for (const unmount of mounted.splice(0)) await unmount();
    },
  };

  windows.push(opened);

  return opened;
};

interface Preview {
  readonly host: HTMLElement;
  /** Whether the preview holds a live frame. */
  readonly live: () => boolean;
  readonly snapshot: () => HTMLImageElement | null;
  readonly placeholder: () => HTMLElement | null;
  /** The pins placed on an element of the preview (not detached). */
  readonly placedPins: () => number;
  /** The preview's container: what the window's observer watches. */
  readonly container: () => HTMLElement;
  /** Waits until the preview's live frame rendered its revision. */
  readonly rendered: () => Promise<void>;
  /** The iframe's place in the window, as the layout would report it. */
  readonly placeFrame: (rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  }) => void;
  readonly unmount: () => Promise<void>;
}

const previewIn = (host: HTMLElement, unmount: () => Promise<void>) => {
  const preview: Preview = {
    host,
    live: () => host.querySelector('iframe') !== null,
    snapshot: () =>
      host.querySelector<HTMLImageElement>(
        '[data-testid="papercraft-snapshot"]',
      ),
    placeholder: () =>
      host.querySelector<HTMLElement>('[data-testid="papercraft-placeholder"]'),
    placedPins: () =>
      host.querySelectorAll(
        '[data-testid="papercraft-pin"]:not([data-detached])',
      ).length,
    container: () =>
      host.querySelector('.papercraft-container') as unknown as HTMLElement,
    rendered: async () => {
      await settle(
        () => frames.latest(host)?.rendered === true && preview.placedPins(),
        (placed) => placed === 1,
        'the preview never rendered with its pin',
      );
    },
    placeFrame: (rect) => {
      const iframe = host.querySelector('iframe');

      assert.ok(iframe !== null, 'the preview has no frame to place');
      Object.defineProperty(iframe, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({
          ...rect,
          left: rect.x,
          top: rect.y,
          right: rect.x + rect.width,
          bottom: rect.y + rect.height,
          toJSON: () => rect,
        }),
      });
      intersection.intersect(iframe as unknown as Element, 1);
    },
    unmount,
  };

  return preview;
};

const ON_SCREEN = { x: 20, y: 40, width: 300, height: 150 };

/** The reader's pointer moving over a preview. */
const hover = async (preview: Preview): Promise<void> => {
  await react.act(async () => {
    const target =
      preview.snapshot() ?? preview.placeholder() ?? preview.container();

    target.dispatchEvent(
      new window.PointerEvent('pointermove', { bubbles: true }) as never,
    );
    await delivered();
  });
};

/** The window's observer seeing a preview come into view, or leave it. */
const scroll = async (preview: Preview, visible: boolean): Promise<void> => {
  await react.act(async () => {
    intersection.intersect(preview.container(), visible ? 1 : 0);
    await delivered();
  });
};

/** Mounts previews one after the other, each rendered before the next. */
const mountAll = async (
  window: ReturnType<typeof windowOf>,
  names: readonly string[],
): Promise<Preview[]> => {
  const previews: Preview[] = [];

  for (const name of names) {
    const preview = await window.mount(name);

    await preview.rendered();
    previews.push(preview);
  }

  return previews;
};

test('a fourth preview takes the live frame of the least recently used one', async () => {
  const w = windowOf();
  const [a, b, c, d] = await mountAll(w, ['a', 'b', 'c', 'd']);

  assert.ok(a !== undefined && b !== undefined && c !== undefined);
  assert.ok(d !== undefined);
  await settle(
    () => a.live(),
    (live) => !live,
    'the first preview kept its frame',
  );
  assert.deepEqual(
    [b.live(), c.live(), d.live()],
    [true, true, true],
    'the three most recent previews are live',
  );
  // Never captured, it draws its placeholder, named after the preview.
  assert.match(a.placeholder()?.textContent ?? '', /run\d+-a\.html/);

  await w.close();
});

test('a dead preview scrolled into view stays dead; the pointer over it promotes it', async () => {
  const w = windowOf();
  const [a, b, c, d] = await mountAll(w, ['a', 'b', 'c', 'd']);

  assert.ok(a !== undefined && b !== undefined && c !== undefined);
  assert.ok(d !== undefined);
  await settle(
    () => a.live(),
    (live) => !live,
    'the first preview kept its frame',
  );

  await scroll(a, true);
  assert.equal(a.live(), false, 'scrolling to it promoted the dead preview');
  assert.deepEqual([b.live(), c.live(), d.live()], [true, true, true]);

  await hover(a);
  await settle(
    () => a.live(),
    (live) => live,
    'the hovered preview never woke',
  );
  await settle(
    () => b.live(),
    (live) => !live,
    'the least recently used preview kept its frame',
  );
  assert.deepEqual([c.live(), d.live()], [true, true]);

  await w.close();
});

test('a live preview on screen is in use: a new preview evicts one out of view first', async () => {
  const w = windowOf();
  const [a] = await mountAll(w, ['a']);

  assert.ok(a !== undefined);
  // The reader keeps looking at the first while two more appear below it:
  // the first is still the one in use.
  await scroll(a, true);

  const [b, c, d] = await mountAll(w, ['b', 'c', 'd']);

  assert.ok(b !== undefined && c !== undefined && d !== undefined);
  await settle(
    () => b.live(),
    (live) => !live,
    'the preview out of view kept its frame',
  );
  assert.deepEqual([a.live(), c.live(), d.live()], [true, true, true]);

  await w.close();
});

test('a dead preview draws its snapshot and the pins of its last scene, also when mounted again', async () => {
  const w = windowOf();
  const [a] = await mountAll(w, ['a']);

  assert.ok(a !== undefined);
  a.placeFrame(ON_SCREEN);
  await settle(
    () => w.captures.length,
    (count) => count > 0,
    'the stable frame on screen was never captured',
  );
  assert.deepEqual(w.captures[0]?.rect, ON_SCREEN);

  await mountAll(w, ['b', 'c', 'd']);
  await settle(
    () => a.live(),
    (live) => !live,
    'the first preview kept its frame',
  );

  const picture = a.snapshot();

  assert.ok(picture !== null, 'the dead preview drew no snapshot');
  assert.equal(picture.getAttribute('src'), `data:image/png;base64,${PNG}`);
  assert.equal(a.placedPins(), 1, "the pin left the dead preview's element");

  // The conversation mounts it again: it comes back as it went.
  await a.unmount();

  const again = await w.mount('a');

  await settle(
    () => again.snapshot() !== null && again.placedPins() === 1,
    (shown) => shown,
    'the preview mounted again lost its snapshot or its pin',
  );
  assert.equal(again.live(), false, 'mounting it again promoted it');

  await w.close();
});

test('a promoted preview keeps its snapshot over the new frame until the frame mounted', async () => {
  const w = windowOf();
  const [a] = await mountAll(w, ['a']);

  assert.ok(a !== undefined);
  a.placeFrame(ON_SCREEN);
  await settle(
    () => w.captures.length,
    (count) => count > 0,
    'the stable frame on screen was never captured',
  );
  await mountAll(w, ['b', 'c', 'd']);
  await settle(
    () => a.live(),
    (live) => !live,
    'the first preview kept its frame',
  );

  // The next frame answers only when the test says so.
  frameOptions.auto = false;
  try {
    await hover(a);
    await settle(
      () => a.live(),
      (live) => live,
      'the hovered preview never woke',
    );

    const frame = await frames.next(a.host, (candidate) => candidate.connected);

    await react.act(delivered);
    assert.ok(
      a.snapshot() !== null,
      'the snapshot went before the frame rendered',
    );

    await react.act(async () => {
      frame.ready();
      await delivered();
    });
    assert.ok(
      a.snapshot() !== null,
      'the snapshot went before the frame mounted',
    );

    await react.act(async () => {
      frame.render(MARKUP, 'markup');
      await delivered();
    });
    await settle(
      () => a.snapshot(),
      (picture) => picture === null,
      'the snapshot stayed over the mounted frame',
    );
  } finally {
    delete frameOptions.auto;
  }

  await w.close();
});

test("a node's expanded modal is live outside the count, and the nodes stay live", async () => {
  const w = windowOf();
  const [a, b, c] = await mountAll(w, ['a', 'b', 'c']);

  assert.ok(a !== undefined && b !== undefined && c !== undefined);

  // The reader's first press on `a` focuses it and brings its controls.
  for (const type of ['down', 'up', 'click'] as const)
    await react.act(async () => {
      frames
        .latest(a.host)
        ?.pointer(type, '#title', {
          x: 10,
          y: 10,
          altKey: false,
          ctrlKey: false,
          metaKey: false,
          shiftKey: false,
        });
      await delivered();
    });
  const expand = await settle(
    () => a.host.querySelector<HTMLElement>('[data-testid="papercraft-expand"]'),
    (found) => found !== null,
    'the focused node never showed expandir',
  );
  await react.act(async () => {
    expand?.focus();
    expand?.click();
    await delivered();
  });

  const dialog = await settle(
    () => document.body.querySelector('[role="dialog"]'),
    (found) => found !== null,
    'expandir never opened the modal',
  );
  await settle(
    () => frames.latest(dialog as Element)?.rendered === true,
    (rendered) => rendered,
    "the modal's preview never rendered",
  );
  assert.deepEqual(
    [
      dialog?.querySelector('iframe') !== null,
      a.live(),
      b.live(),
      c.live(),
    ],
    [true, true, true, true],
    'the modal took one of the three live frames',
  );

  await w.close();
});
