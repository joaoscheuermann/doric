// The measure frame, app side (measure.ts, spec "Frame de medida"): one
// hidden sandboxed iframe that measures a drawn SVG, reached by a `hello`
// window message from the frame and a `connect` that hands it a port.
//
// The frame is the real boundary: each iframe the measurer inserts gets a
// fake `contentWindow` that takes the `connect` and its port and answers on
// that port as the runtime would; the test says `hello` from it with a window
// message whose `source` is that `contentWindow`.
//
// Contract matrix (plan §4, measure.test rows 1–7):
// - the first measure inserts one hidden `sandbox="allow-scripts"` iframe
//   whose `src` is the frame document running `client/frames/diagram.js`;
// - only a `hello` from that iframe's window is answered, with one
//   `connect` carrying a port;
// - a measure posts one `render` after `ready` and resolves with the layout;
//   measures run one at a time;
// - an off-schema message or a timeout is `unavailable`, removes the frame
//   (an off-schema message is logged), and the next measure starts afresh.

import './support/dom.js';

import assert from 'node:assert/strict';
import { after, afterEach, describe, test } from 'node:test';

import {
  createMeasurer,
  diagramFrameSrc,
  type MeasureOptions,
  type Measurer,
} from '../../src/client/measure.js';
import { RenderError } from '../../src/client/renderer.js';
import type { DiagramLayout } from '../../src/contracts/index.js';
import { closeDom, iframes, settle, window } from './support/dom.js';

after(closeDom);

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><g data-cell-id="a"/></svg>';
const LAYOUT: DiagramLayout = {
  width: 80,
  height: 40,
  cells: [{ id: 'a', x: 1, y: 2, width: 30, height: 20 }],
};

const isUnavailable = (error: unknown): boolean =>
  error instanceof RenderError && error.code === 'unavailable';

/** What one iframe's fake runtime saw and does. */
interface FakeFrame {
  readonly iframe: HTMLIFrameElement;
  readonly contentWindow: { postMessage(...args: unknown[]): void };
  readonly connects: Array<{ data: unknown; ports: readonly unknown[] }>;
  readonly renders: unknown[];
  port?: MessagePort;
  /** Answers a `render`; by default, `rendered` with LAYOUT. */
  onRender: (frame: FakeFrame, message: unknown) => void;
  /** Says `hello` from this frame's window. */
  hello(): void;
  /** Posts `message` on the frame's port. */
  reply(message: unknown): void;
}

const frames = new WeakMap<object, FakeFrame>();
const created: FakeFrame[] = [];

const answerLayout = (frame: FakeFrame) =>
  frame.reply({ type: 'rendered', ...LAYOUT });

const fakeFor = (iframe: HTMLIFrameElement): FakeFrame => {
  const known = frames.get(iframe);

  if (known !== undefined) return known;

  const frame: FakeFrame = {
    iframe,
    connects: [],
    renders: [],
    onRender: answerLayout,
    contentWindow: {
      postMessage: (data: unknown, second?: unknown, third?: unknown) => {
        const transfer = (
          Array.isArray(third)
            ? third
            : ((second as { transfer?: unknown[] } | undefined)?.transfer ?? [])
        ) as unknown[];

        frame.connects.push({ data, ports: transfer });

        const message = data as { drawio?: unknown; kind?: unknown };
        const port = transfer[0];

        if (message.drawio !== 1 || message.kind !== 'connect') return;
        if (!(port instanceof MessagePort) || frame.port !== undefined) return;

        frame.port = port;
        port.onmessage = (event: MessageEvent) => {
          const render = event.data as { type?: unknown };

          if (render.type !== 'render') return;
          frame.renders.push(event.data);
          frame.onRender(frame, event.data);
        };
        port.postMessage({ type: 'ready', version: 1 });
      },
    },
    hello: () => {
      window.dispatchEvent(
        new window.MessageEvent('message', {
          data: { drawio: 1, kind: 'hello' },
          source: frame.contentWindow as never,
        }),
      );
    },
    reply: (message) => frame.port?.postMessage(message),
  };

  frames.set(iframe, frame);
  created.push(frame);

  return frame;
};

// Every iframe's window, as far as the app reaches it, is its fake's.
Object.defineProperty(window.HTMLIFrameElement.prototype, 'contentWindow', {
  configurable: true,
  get(this: HTMLIFrameElement) {
    return fakeFor(this).contentWindow;
  },
});

/** The iframes the measurer inserted in this test, in order. */
const seen: HTMLIFrameElement[] = [];

/** The fake of the `count`-th iframe the measurer inserted, once it is in. */
const frameNumber = async (count: number): Promise<FakeFrame> => {
  for (let round = 0; round < 100; round += 1) {
    for (const iframe of iframes()) {
      if (!seen.includes(iframe)) seen.push(iframe);
    }

    const iframe = seen[count - 1];

    if (iframe !== undefined) return fakeFor(iframe);
    await settle(1);
  }

  throw new Error(`no iframe #${count}; ${iframes().length} in the body`);
};

let measurer: Measurer | undefined;

const TEST_SRC = 'doric://app/frame/index.html?entry=test';

/** A measurer into the test document; `frameSrc` is TEST_SRC unless `defaultSrc`. */
const open = (options: MeasureOptions = {}, defaultSrc = false): Measurer => {
  measurer = createMeasurer({
    document: window.document as unknown as Document,
    timeoutMs: 1_000,
    ...(defaultSrc ? {} : { frameSrc: TEST_SRC }),
    ...options,
  });

  return measurer;
};

afterEach(() => {
  measurer?.dispose();
  measurer = undefined;
  seen.length = 0;
  for (const frame of created.splice(0)) frame.port?.close();
  for (const iframe of iframes()) iframe.remove();
});

describe('the measure frame', () => {
  test('the first measure inserts one hidden sandboxed frame running diagram.js (row 1)', async () => {
    const entry = new URL('../../src/client/frames/diagram.js', import.meta.url)
      .href;

    assert.equal(
      diagramFrameSrc(),
      `doric://app/frame/index.html?entry=${encodeURIComponent(entry)}`,
    );
    assert.match(diagramFrameSrc(), /%2Fclient%2Fframes%2Fdiagram\.js$/u);

    const measuring = open({}, true);

    assert.equal(iframes().length, 0, 'nothing before the first measure');

    const pending = measuring.measure(SVG, 'light');
    const frame = await frameNumber(1);

    assert.equal(iframes().length, 1);
    assert.equal(frame.iframe.getAttribute('sandbox'), 'allow-scripts');
    assert.equal(frame.iframe.getAttribute('aria-hidden'), 'true');
    assert.equal(frame.iframe.getAttribute('tabindex'), '-1');
    assert.equal(frame.iframe.style.visibility, 'hidden');
    assert.notEqual(frame.iframe.style.display, 'none');
    assert.equal(frame.iframe.getAttribute('src'), diagramFrameSrc());

    frame.hello();
    assert.deepEqual(await pending, LAYOUT);
  });

  test('a hello from another window is ignored (row 2)', async () => {
    const pending = open().measure(SVG, 'light');
    const frame = await frameNumber(1);
    const stranger: unknown[] = [];
    const other = {
      postMessage: (...args: unknown[]) => {
        stranger.push(args);
      },
    };

    window.dispatchEvent(
      new window.MessageEvent('message', {
        data: { drawio: 1, kind: 'hello' },
        source: other as never,
      }),
    );
    window.dispatchEvent(
      new window.MessageEvent('message', {
        data: { drawio: 1, kind: 'hello' },
      }),
    );
    await settle();

    assert.deepEqual(frame.connects, []);
    assert.deepEqual(stranger, []);

    frame.hello();
    assert.deepEqual(await pending, LAYOUT);
  });

  test("a hello from the frame's window is answered with connect and a port (row 3)", async () => {
    const pending = open().measure(SVG, 'light');
    const frame = await frameNumber(1);

    frame.hello();
    await pending;

    assert.equal(frame.connects.length, 1);
    assert.deepEqual(frame.connects[0]?.data, { drawio: 1, kind: 'connect' });
    assert.equal(frame.connects[0]?.ports.length, 1);
    assert.ok(frame.connects[0]?.ports[0] instanceof MessagePort);
  });

  test('a measure posts one render and resolves with the layout (row 4)', async () => {
    const pending = open().measure(SVG, 'dark');
    const frame = await frameNumber(1);

    frame.hello();

    assert.deepEqual(await pending, LAYOUT);
    assert.deepEqual(frame.renders, [
      { type: 'render', version: 1, svg: SVG, theme: 'dark' },
    ]);
  });

  test('measures run one at a time, in call order (row 5)', async () => {
    const measuring = open();
    const second: DiagramLayout = { width: 5, height: 6, cells: [] };
    const first = measuring.measure(SVG, 'light');
    const then = measuring.measure(
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
      'dark',
    );
    const frame = await frameNumber(1);

    frame.onRender = () => undefined;
    frame.hello();
    await settle();

    assert.equal(frame.renders.length, 1);
    assert.deepEqual(frame.renders[0], {
      type: 'render',
      version: 1,
      svg: SVG,
      theme: 'light',
    });

    frame.reply({ type: 'rendered', ...LAYOUT });
    assert.deepEqual(await first, LAYOUT);
    await settle();

    assert.equal(frame.renders.length, 2);
    assert.deepEqual(frame.renders[1], {
      type: 'render',
      version: 1,
      svg: '<svg xmlns="http://www.w3.org/2000/svg"/>',
      theme: 'dark',
    });

    frame.reply({ type: 'rendered', ...second });
    assert.deepEqual(await then, second);
  });

  test('an off-schema message is unavailable, logged, and the frame replaced (row 6)', async () => {
    const logged: string[] = [];
    const measuring = open({ log: (message) => logged.push(message) });
    const failing = measuring.measure(SVG, 'light');
    const broken = await frameNumber(1);

    broken.onRender = (frame) =>
      frame.reply({ type: 'rendered', width: -1, height: 0, cells: [] });
    broken.hello();

    await assert.rejects(failing, isUnavailable);
    assert.ok(logged.length > 0, 'the off-schema message is logged');
    assert.ok(logged.every((message) => typeof message === 'string'));
    assert.equal(broken.iframe.isConnected, false);
    assert.equal(iframes().length, 0);

    const retried = measuring.measure(SVG, 'light');
    const fresh = await frameNumber(2);

    assert.notEqual(fresh.iframe, broken.iframe);
    fresh.hello();
    assert.deepEqual(await retried, LAYOUT);
    assert.equal(iframes().length, 1);
  });

  test('a timeout is unavailable and removes the frame (row 7)', async () => {
    const measuring = open({ timeoutMs: 50 });
    const silent = measuring.measure(SVG, 'light');
    const mute = await frameNumber(1);

    mute.onRender = () => undefined;
    mute.hello();

    await assert.rejects(silent, isUnavailable);
    assert.equal(mute.iframe.isConnected, false);

    const unanswered = measuring.measure(SVG, 'light');

    await frameNumber(2);
    await assert.rejects(unanswered, isUnavailable);
    assert.equal(iframes().length, 0);
  });
});
