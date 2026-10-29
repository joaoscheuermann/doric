// The measure frame (spec "Frame de medida"): the closed wire shape the app
// parses every frame message with (frame-protocol.ts), and the frame's
// runtime (frames/diagram/runtime.ts) driven as the app drives it — a
// happy-dom window is the frame, its parent a recording double, and the app's
// end of a real `MessageChannel` arrives with the `connect` window message.
// Layout is the one thing happy-dom does not compute, so boxes are stubbed.
//
// Contract matrix (plan §4, frame.test rows 1–5):
// - `parseFrameMessage`: ready, rendered and error parse; extra keys, a
//   negative or non-finite number, an unknown type, another version, more
//   than MAX_CELLS boxes and an error over 4096 characters do not;
// - handshake: `hello` to the parent, `ready` on the port of `connect`;
// - `sanitizeSvg`: scripts, frames, embeds, `on*` handlers, foreign links and
//   media foreignObjects go; local and `data:image/` links and a text-only
//   foreignObject stay (Q3);
// - a render answers `rendered` with the svg's size and one box per
//   `data-cell-id`, in document order, relative to the svg;
// - an SVG it cannot read answers `error`.

import './support/dom.js';

import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';

import { Window } from 'happy-dom';

import {
  type FrameMessage,
  parseFrameMessage,
} from '../../src/client/frame-protocol.js';
import {
  type DiagramFrameWindow,
  sanitizeSvg,
  startDiagramFrame,
} from '../../src/client/frames/diagram/runtime.js';
import { MAX_CELLS } from '../../src/contracts/index.js';
import { closeDom, window } from './support/dom.js';

after(closeDom);

const SVG_NS = 'http://www.w3.org/2000/svg';

const cell = (id: string) => ({ id, x: 0, y: 1.5, width: 10, height: 20 });

describe('parseFrameMessage', () => {
  test('parses the three messages and refuses anything off the wire shape (row 1)', () => {
    const accepted: unknown[] = [
      { type: 'ready', version: 1 },
      { type: 'rendered', width: 400, height: 300.5, cells: [cell('a')] },
      { type: 'rendered', width: 0, height: 0, cells: [] },
      {
        type: 'rendered',
        width: 1,
        height: 1,
        cells: Array.from({ length: MAX_CELLS }, (_, index) =>
          cell(`c${index}`),
        ),
      },
      { type: 'error', message: 'bad svg' },
      { type: 'error', message: 'x'.repeat(4096) },
    ];

    for (const data of accepted) {
      assert.deepEqual(parseFrameMessage(data), data);
    }

    const refused: unknown[] = [
      undefined,
      'ready',
      { type: 'ready', version: 1, extra: true },
      { type: 'ready', version: 2 },
      { type: 'rendered', width: 1, height: 1, cells: [], extra: 1 },
      { type: 'rendered', width: -1, height: 1, cells: [] },
      {
        type: 'rendered',
        width: 1,
        height: Number.POSITIVE_INFINITY,
        cells: [],
      },
      { type: 'rendered', width: Number.NaN, height: 1, cells: [] },
      {
        type: 'rendered',
        width: 1,
        height: 1,
        cells: [{ ...cell('a'), x: -0.5 }],
      },
      { type: 'rendered', width: 1, height: 1, cells: [{ ...cell('') }] },
      {
        type: 'rendered',
        width: 1,
        height: 1,
        cells: [{ ...cell('a'), extra: 1 }],
      },
      {
        type: 'rendered',
        width: 1,
        height: 1,
        cells: Array.from({ length: MAX_CELLS + 1 }, (_, index) =>
          cell(`c${index}`),
        ),
      },
      { type: 'error', message: 'x'.repeat(4097) },
      { type: 'error', message: 'bad', extra: 1 },
      { type: 'scene', nodes: [] },
    ];

    for (const data of refused) {
      assert.equal(
        parseFrameMessage(data),
        undefined,
        JSON.stringify(data)?.slice(0, 80),
      );
    }
  });
});

/** A started frame: its window, what it posted to its parent, and its port. */
interface Frame {
  readonly win: DiagramFrameWindow;
  readonly toParent: Array<{ data: unknown; targetOrigin: unknown }>;
  readonly messages: FrameMessage[];
  readonly port: MessagePort;
  next(from: number): Promise<FrameMessage>;
  close(): Promise<void>;
}

/** Starts the runtime on a fresh window whose parent records what it gets. */
const startFrame = (
  before?: (win: DiagramFrameWindow) => void,
): Omit<Frame, 'port' | 'messages' | 'next'> => {
  const happy = new Window({
    url: 'https://frame.test/',
    settings: { disableIframePageLoading: true, disableCSSFileLoading: true },
  });
  const win = happy as unknown as DiagramFrameWindow;
  const toParent: Frame['toParent'] = [];

  Object.defineProperty(win, 'parent', {
    configurable: true,
    value: {
      postMessage: (data: unknown, targetOrigin: unknown) => {
        toParent.push({ data, targetOrigin });
      },
    },
  });
  before?.(win);
  startDiagramFrame(win);

  return {
    win,
    toParent,
    close: () => happy.happyDOM.close(),
  };
};

/** Hands the frame its port with the `connect` window message. */
const connect = (win: DiagramFrameWindow, port: MessagePort): void => {
  const frameWindow = win as unknown as {
    MessageEvent: typeof MessageEvent;
    dispatchEvent(event: Event): boolean;
  };

  frameWindow.dispatchEvent(
    new frameWindow.MessageEvent('message', {
      data: { drawio: 1, kind: 'connect' },
      ports: [port],
    }),
  );
};

/** A started, connected frame. */
const openFrame = (before?: (win: DiagramFrameWindow) => void): Frame => {
  const started = startFrame(before);
  const channel = new MessageChannel();
  const messages: FrameMessage[] = [];
  const waiters = new Set<() => void>();

  channel.port1.onmessage = (event: MessageEvent) => {
    messages.push(event.data as FrameMessage);
    for (const wake of [...waiters]) wake();
  };
  connect(started.win, channel.port2);

  return {
    ...started,
    messages,
    port: channel.port1,
    next: (from) =>
      new Promise<FrameMessage>((resolve, reject) => {
        const look = () => {
          const found = messages[from];

          if (found === undefined) return;
          waiters.delete(look);
          clearTimeout(timer);
          resolve(found);
        };
        const timer = setTimeout(() => {
          waiters.delete(look);
          reject(
            new Error(
              `no frame message #${from}; got ${JSON.stringify(messages)}`,
            ),
          );
        }, 2_000);

        waiters.add(look);
        look();
      }),
    close: async () => {
      channel.port1.close();
      channel.port2.close();
      await started.close();
    },
  };
};

describe('the frame runtime', () => {
  test('says hello to its parent, then ready on the port it is given (row 2)', async () => {
    const frame = openFrame();

    try {
      assert.deepEqual(await frame.next(0), { type: 'ready', version: 1 });
      assert.deepEqual(
        frame.toParent.map(({ data }) => data),
        [{ drawio: 1, kind: 'hello' }],
      );
      assert.equal(frame.toParent[0]?.targetOrigin, '*');
    } finally {
      await frame.close();
    }
  });

  test('sanitizeSvg removes what can run or reach out, keeps text and local links (row 3, Q3)', () => {
    const markup = `<svg xmlns="${SVG_NS}" xmlns:xlink="http://www.w3.org/1999/xlink" onload="alert(1)">
      <script>alert(1)</script>
      <g id="keep" onClick="x()" data-cell-id="a"><script>nested()</script><rect width="1" height="1"/></g>
      <foreignObject id="text"><div xmlns="http://www.w3.org/1999/xhtml" style="color: red">A<br/><b>B</b></div></foreignObject>
      <foreignObject id="media"><div xmlns="http://www.w3.org/1999/xhtml"><img src="x.png"/></div></foreignObject>
      <foreignObject id="form"><div xmlns="http://www.w3.org/1999/xhtml"><span><input value="x"/></span></div></foreignObject>
      <iframe src="https://evil.test/"/>
      <object data="https://evil.test/"/>
      <embed src="https://evil.test/"/>
      <a id="far" href="https://evil.test/"><text>x</text></a>
      <a id="xfar" xlink:href=" javascript:alert(1)"><text>y</text></a>
      <use id="local" href="#keep"/>
      <use id="xlocal" xlink:href=" #keep"/>
      <image id="png" href="data:image/png;base64,AAAA"/>
      <image id="remote" href="http://evil.test/y.png"/>
    </svg>`;
    const svg = new window.DOMParser().parseFromString(markup, 'image/svg+xml')
      .documentElement as unknown as Element;
    const all = () => [...svg.getElementsByTagName('*')];
    const byId = (id: string) =>
      all().find((element) => element.getAttribute('id') === id);

    sanitizeSvg(svg);

    for (const tag of ['script', 'iframe', 'object', 'embed', 'img', 'input']) {
      assert.equal(svg.getElementsByTagName(tag).length, 0, tag);
    }
    assert.equal(svg.hasAttribute('onload'), false);
    assert.equal(byId('keep')?.hasAttribute('onClick'), false);
    assert.equal(byId('keep')?.hasAttribute('onclick'), false);
    assert.equal(byId('keep')?.getAttribute('data-cell-id'), 'a');
    assert.equal(byId('keep')?.getElementsByTagName('rect').length, 1);

    const text = byId('text');

    assert.ok(text, 'a text-only foreignObject stays');
    assert.equal(text.textContent, 'AB');
    assert.equal(byId('media'), undefined);
    assert.equal(byId('form'), undefined);

    assert.equal(byId('far')?.hasAttribute('href'), false);
    assert.equal(byId('xfar')?.hasAttribute('xlink:href'), false);
    assert.equal(byId('local')?.getAttribute('href'), '#keep');
    assert.equal(byId('xlocal')?.getAttribute('xlink:href'), ' #keep');
    assert.equal(
      byId('png')?.getAttribute('href'),
      'data:image/png;base64,AAAA',
    );
    assert.equal(byId('remote')?.hasAttribute('href'), false);
  });

  test('a render answers the svg size and its cell boxes, relative and in order (row 4)', async () => {
    // Each element's box, as the stub reports it: `data-box="x,y,w,h"`.
    const frame = openFrame((win) => {
      const element = (win as unknown as { Element: typeof Element }).Element;

      element.prototype.getBoundingClientRect = function box(this: Element) {
        const [x = 0, y = 0, width = 0, height = 0] = (
          this.getAttribute('data-box') ?? '0,0,0,0'
        )
          .split(',')
          .map(Number);

        return {
          x,
          y,
          width,
          height,
          left: x,
          top: y,
          right: x + width,
          bottom: y + height,
          toJSON: () => ({}),
        } as DOMRect;
      };
    });

    try {
      await frame.next(0);

      const svg = `<svg xmlns="${SVG_NS}" width="400" height="300" data-box="100,50,400,300">
        <g data-cell-id="a" data-box="110,70,30,40"><rect data-cell-id="a-child" data-box="120,80,5,5"/></g>
        <g data-box="0,0,1,1"><rect data-cell-id="b" data-box="300,250,50,20"/></g>
      </svg>`;

      frame.port.postMessage({
        type: 'render',
        version: 1,
        svg,
        theme: 'light',
      });

      assert.deepEqual(await frame.next(1), {
        type: 'rendered',
        width: 400,
        height: 300,
        cells: [
          { id: 'a', x: 10, y: 20, width: 30, height: 40 },
          { id: 'a-child', x: 20, y: 30, width: 5, height: 5 },
          { id: 'b', x: 200, y: 200, width: 50, height: 20 },
        ],
      });
    } finally {
      await frame.close();
    }
  });

  test('a render skips elements with an empty data-cell-id', async () => {
    const frame = openFrame();

    try {
      await frame.next(0);

      frame.port.postMessage({
        type: 'render',
        version: 1,
        svg: `<svg xmlns="${SVG_NS}" width="10" height="10"><rect data-cell-id=""/><rect data-cell-id="a"/></svg>`,
        theme: 'light',
      });

      const answer = await frame.next(1);

      assert.ok(answer.type === 'rendered');
      assert.deepEqual(
        answer.cells.map((cell) => cell.id),
        ['a'],
      );
    } finally {
      await frame.close();
    }
  });

  test('an SVG it cannot read answers error (row 5)', async () => {
    const frame = openFrame();

    try {
      await frame.next(0);

      frame.port.postMessage({
        type: 'render',
        version: 1,
        svg: `<svg xmlns="${SVG_NS}"><g></svg`,
        theme: 'dark',
      });

      const broken = await frame.next(1);

      assert.equal(broken.type, 'error');
      assert.ok(
        broken.type === 'error' &&
          typeof broken.message === 'string' &&
          broken.message.length <= 4096,
      );

      frame.port.postMessage({
        type: 'render',
        version: 1,
        svg: '<html xmlns="http://www.w3.org/1999/xhtml"/>',
        theme: 'dark',
      });

      assert.equal((await frame.next(2)).type, 'error');
    } finally {
      await frame.close();
    }
  });
});
