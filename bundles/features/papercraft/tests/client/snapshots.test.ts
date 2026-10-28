// A preview's snapshot and stand-in, at the surface (isolamento.md,
// "Virtualização"): a live frame is captured through the window's capture
// only once it is stable on screen, a dead preview draws the picture only in
// the theme and at the width it was taken in, a capture that fails leaves the
// placeholder, and a frame that never says it mounted shows its stand-in with
// the fallback until it does. The frame is a fake speaking the frame protocol
// (`support/fake-frame.ts`); the window's capture is a fake, and happy-dom's
// missing layout is filled in by placing the iframe in the window.
//
// Contract matrix:
// - off screen, or while its scene keeps changing, a live frame is not
//   captured; once it holds still wholly on screen it is, by its rectangle in
//   the window;
// - mid-gesture, a live frame is not captured;
// - a dead preview draws its picture at the content size it covers, and a
//   placeholder in another theme or at another width;
// - a capture that fails is silent: the dead preview draws its placeholder;
// - a frame that does not say it mounted in time shows its stand-in and the
//   surface reports the fallback; its `mounted` later clears both.

import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';

import { Window } from 'happy-dom';
import { createElement } from 'react';

import {
  delivered,
  type FakeFrame,
  type FakeOptions,
  fakeFrames,
} from './support/fake-frame.js';
import { fakeIntersection } from './support/fake-intersection.js';

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
type Snapshots = typeof import('../../src/client/surface/snapshots.js');

let react: React;
let reactDomClient: ReactDomClient;
let surface: Surface;
let snapshots: Snapshots;

const intersection = fakeIntersection();

before(async () => {
  [react, reactDomClient, surface, snapshots] = await Promise.all([
    import('react'),
    import('react-dom/client'),
    import('../../src/client/surface/preview-surface.js'),
    import('../../src/client/surface/snapshots.js'),
  ]);
});

after(async () => {
  intersection.restore();
  await window.happyDOM.abort();
  await window.happyDOM.close();
});

const MARKUP =
  '<!DOCTYPE html><html><head></head><body><p id="hi">oi</p></body></html>';

const PNG = 'iVBORw0KGgo=';
const ON_SCREEN = { x: 20, y: 40, width: 640, height: 300 };
const OFF_SCREEN = { x: 20, y: -120, width: 640, height: 300 };

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Waits a while, letting React commit what came in between. */
const wait = async (ms: number): Promise<void> => {
  await react.act(async () => {
    await new Promise((done) => setTimeout(done, ms));
  });
};

/** Polls until `read()` holds. */
const settle = async <T>(
  read: () => T,
  holds: (value: T) => boolean,
  message: string,
): Promise<T> => {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const value = read();

    if (holds(value)) return value;

    await wait(10);
  }

  throw new Error(message);
};

/** No test waits longer than this, should a frame never come. */
const TEST_TIMEOUT = 15_000;

/** Longer than a frame needs to be captured once it is stable on screen. */
const SETTLED = 1_000;

/** The window's capture, recording each rectangle it was asked for. */
const fakeCapture = () => {
  const rects: Rect[] = [];
  const state = { busy: false, fails: false };

  return {
    rects,
    state,
    snapshots: {
      capture: async (rect: Rect) => {
        rects.push(rect);
        if (state.fails) throw new Error('unavailable');

        return { png: PNG, width: 1280, height: 600, scale: 2 };
      },
      busy: () => state.busy,
    },
  };
};

let runs = 0;

/** What a test left mounted, should it fail before it unmounts. */
const leftovers = new Set<() => Promise<void>>();

afterEach(async () => {
  for (const unmount of [...leftovers]) await unmount();
  document.documentElement.classList.remove('dark');
});

/** Mounts a surface; `artifactId` mounts the same revision as another. */
const mount = (
  options: FakeOptions = {},
  artifactId = `shot-${String(++runs)}`,
) => {
  const frames = fakeFrames(window as never, {
    size: { width: 640, height: 300 },
    ...options,
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = reactDomClient.createRoot(host);
  const modes: string[] = [];

  const render = async (props: Record<string, unknown>) => {
    await react.act(async () => {
      root.render(
        createElement(surface.PreviewSurface, {
          artifactId,
          revision: 1,
          markup: MARKUP,
          area: { width: 640, height: 480 },
          title: 'Checkout',
          onMode: (mode: string) => modes.push(mode),
          ...props,
        } as never),
      );
      await delivered();
    });
  };

  /** The live frame, once `holds` (rendered, by default). */
  const frame = async (
    holds?: (frame: FakeFrame) => boolean,
  ): Promise<FakeFrame> => {
    let found: FakeFrame | undefined;

    await react.act(async () => {
      found = await frames.next(host, holds);
      await delivered();
    });
    assert.ok(found !== undefined);

    return found;
  };

  const unmount = async (): Promise<void> => {
    if (!leftovers.delete(unmount)) return;
    await react.act(async () => {
      root.unmount();
      await delivered();
    });
    frames.dispose();
    host.remove();
  };

  leftovers.add(unmount);

  /** Places the live iframe in the window, as the layout would. */
  const place = async (rect: Rect): Promise<void> => {
    const iframe = host.querySelector('iframe');

    assert.ok(iframe !== null, 'the surface holds no frame');
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
    await react.act(async () => {
      intersection.intersect(
        iframe as unknown as Element,
        rect.y < 0 || rect.x < 0 ? 0.5 : 1,
      );
    });
  };

  return {
    artifactId,
    render,
    frame,
    place,
    modes,
    snapshot: () =>
      host.querySelector<HTMLImageElement>(
        '[data-testid="papercraft-snapshot"]',
      ),
    placeholder: () =>
      host.querySelector<HTMLElement>('[data-testid="papercraft-placeholder"]'),
    unmount,
  };
};

test('a live frame is captured only once it holds still, wholly on screen', {
  timeout: TEST_TIMEOUT,
}, async () => {
  const capture = fakeCapture();
  const m = mount();

  await m.render({ snapshots: capture.snapshots });
  const frame = await m.frame();

  await m.place(OFF_SCREEN);
  await wait(SETTLED);
  assert.equal(capture.rects.length, 0, 'a frame off screen was captured');

  // On screen, but what it renders keeps changing.
  await m.place(ON_SCREEN);
  for (let index = 0; index < 8; index += 1) {
    await react.act(async () => {
      frame.sendScene();
      await delivered();
    });
    await wait(100);
  }
  assert.equal(capture.rects.length, 0, 'a frame still changing was captured');

  await settle(
    () => capture.rects.length,
    (count) => count > 0,
    'the frame holding still on screen was never captured',
  );
  assert.deepEqual(capture.rects, [ON_SCREEN]);

  await m.unmount();
});

test('a live frame is not captured mid-gesture', {
  timeout: TEST_TIMEOUT,
}, async () => {
  const capture = fakeCapture();
  const m = mount();

  capture.state.busy = true;
  await m.render({ snapshots: capture.snapshots });
  await m.frame();
  await m.place(ON_SCREEN);
  await wait(SETTLED);
  assert.equal(capture.rects.length, 0, 'the frame was captured mid-gesture');

  capture.state.busy = false;
  await settle(
    () => capture.rects.length,
    (count) => count > 0,
    'the frame was never captured once the gesture ended',
  );

  await m.unmount();
});

test('a dead preview draws its picture only in the theme and at the width it was taken in', {
  timeout: TEST_TIMEOUT,
}, async () => {
  const capture = fakeCapture();
  const m = mount();

  await m.render({ snapshots: capture.snapshots });
  await m.frame();
  await m.place(ON_SCREEN);
  await settle(
    () => capture.rects.length,
    (count) => count > 0,
    'the frame was never captured',
  );
  await wait(50);

  await m.render({ snapshots: capture.snapshots, live: false });
  const picture = m.snapshot();

  assert.ok(picture !== null, 'the dead preview drew no picture');
  assert.equal(picture.getAttribute('src'), `data:image/png;base64,${PNG}`);
  // Taken at twice the pixels, it covers the frame's content size.
  assert.equal(picture.style.width, '640px');
  assert.equal(picture.style.height, '300px');

  // A dead preview in the other mode draws its placeholder. (It is mounted
  // in that mode: happy-dom's observer of the root's class may be collected.)
  await m.unmount();
  document.documentElement.classList.add('dark');
  const dark = mount({}, m.artifactId);
  await dark.render({ snapshots: capture.snapshots, live: false });
  assert.ok(
    dark.placeholder() !== null,
    'the dark preview drew no placeholder',
  );
  assert.ok(dark.snapshot() === null, 'the light picture showed in dark mode');
  await dark.unmount();

  document.documentElement.classList.remove('dark');
  const light = mount({}, m.artifactId);
  await light.render({ snapshots: capture.snapshots, live: false });
  assert.ok(
    light.snapshot() !== null,
    'the picture did not come back in light',
  );

  // Live again at a narrower canvas, it renders at another width, and is not
  // captured there (happy-dom places the new iframe nowhere).
  await light.render({
    snapshots: capture.snapshots,
    live: true,
    area: { width: 500, height: 480 },
  });
  await light.frame((candidate) => candidate.rendered);
  await wait(50);
  await light.render({
    snapshots: capture.snapshots,
    live: false,
    area: { width: 500, height: 480 },
  });
  assert.ok(light.snapshot() === null, 'the picture showed at another width');
  assert.ok(light.placeholder() !== null);

  await light.unmount();
});

test('a capture that fails is silent: the dead preview draws its placeholder', {
  timeout: TEST_TIMEOUT,
}, async () => {
  const capture = fakeCapture();
  const m = mount();

  capture.state.fails = true;
  await m.render({ snapshots: capture.snapshots });
  await m.frame();
  await m.place(ON_SCREEN);
  await settle(
    () => capture.rects.length,
    (count) => count > 0,
    'the frame was never captured',
  );
  await wait(50);

  await m.render({ snapshots: capture.snapshots, live: false });
  assert.ok(m.snapshot() === null);
  assert.equal(m.placeholder()?.textContent, 'Checkout');
  assert.equal(m.placeholder()?.style.width, '640px');

  await m.unmount();
});

test('a frame that never says it mounted shows its stand-in and the fallback, until it mounts', {
  timeout: TEST_TIMEOUT,
}, async () => {
  const m = mount({ auto: false });

  await m.render({ readyTimeout: 40 });
  const frame = await m.frame((candidate) => candidate.connected);

  await settle(
    () => m.placeholder(),
    (shown) => shown !== null,
    'the canvas stayed empty past the timeout',
  );
  assert.equal(m.modes.at(-1), 'fallback');

  await react.act(async () => {
    frame.ready();
    await delivered();
  });
  await react.act(async () => {
    frame.render(MARKUP, 'markup');
    await delivered();
  });
  await settle(
    () => m.placeholder(),
    (shown) => shown === null,
    'the stand-in stayed over the mounted frame',
  );
  assert.equal(m.modes.at(-1), 'markup');

  await m.unmount();
});

test('the snapshot cache forgets the least recently drawn picture past its limit', {
  timeout: TEST_TIMEOUT,
}, () => {
  const key = (index: number) => ({
    artifactId: 'cache',
    revision: index,
    theme: 'light' as const,
    width: 100,
  });
  const picture = { src: 'data:image/png;base64,x', width: 100, height: 50 };

  for (let index = 0; index < snapshots.SNAPSHOT_CACHE_LIMIT; index += 1) {
    snapshots.keepSnapshot(key(index), picture);
  }
  // Drawn again, the first is the most recent now.
  assert.ok(snapshots.snapshotOf(key(0)) !== undefined);
  snapshots.keepSnapshot(key(snapshots.SNAPSHOT_CACHE_LIMIT), picture);

  assert.ok(snapshots.snapshotOf(key(0)) !== undefined);
  assert.equal(snapshots.snapshotOf(key(1)), undefined);
});
