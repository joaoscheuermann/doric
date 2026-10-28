// A revision compiled before the frame (`tests/fixtures/old-revision`: its
// own portal container inside the root, a `.dark` wrapper, React from the
// import map) mounts in the frame unchanged, and what it portals into its
// container is in the scene with its origin stamp.
//
// The revision is real React code that reaches for the window's globals, so
// this file gives the globals one happy-dom window, the frame's, as the
// browser would.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { Window } from 'happy-dom';

import {
  type FrameMessage,
  frameMessage,
  PROTOCOL,
} from '../../src/client/frame-protocol.js';
import {
  type FrameWindow,
  startPreviewFrame,
} from '../../src/client/frames/preview/runtime.js';

const window = new Window({
  url: 'https://frame.test/',
  settings: { disableCSSFileLoading: true },
});

for (const name of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'HTMLIFrameElement',
  'Element',
  'Node',
  'Event',
  'MutationObserver',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
] as const) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: window[name as keyof Window],
    writable: true,
  });
}

after(async () => {
  await window.happyDOM.abort();
  await window.happyDOM.close();
});

/** The fixture's source, next to the compiled tests' tree. */
const OLD_REVISION = new URL(
  '../../../tests/fixtures/old-revision/index.js',
  import.meta.url,
).href;

void test('an old revision mounts in the frame with its portal container in the scene', async () => {
  startPreviewFrame(window as unknown as FrameWindow);

  const channel = new MessageChannel();
  const messages: FrameMessage[] = [];
  const invalid: unknown[] = [];
  let wake: (() => void) | undefined;

  channel.port1.onmessage = (event: MessageEvent) => {
    const parsed = frameMessage(event.data);

    if (parsed === undefined) invalid.push(event.data);
    else messages.push(parsed);
    wake?.();
  };

  const until = async (accept: (message: FrameMessage) => boolean) => {
    const deadline = Date.now() + 5000;

    for (;;) {
      const found = messages.find(accept);

      if (found !== undefined) return found;
      if (Date.now() > deadline) {
        throw new Error(
          `No such message: ${JSON.stringify(messages.map((m) => m.kind))}`,
        );
      }

      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, 20);
      });
    }
  };

  try {
    window.dispatchEvent(
      new window.MessageEvent('message', {
        data: { papercraft: PROTOCOL, kind: 'connect' },
        ports: [channel.port2 as never],
      }),
    );
    await until((message) => message.kind === 'ready');

    channel.port1.postMessage({
      kind: 'init',
      content: { kind: 'module', module: OLD_REVISION },
      theme: 'dark',
      capture: 'none',
    });

    const mounted = await until((message) => message.kind === 'mounted');

    assert.deepEqual(mounted, {
      kind: 'mounted',
      mode: 'module',
      layout: 'padded',
    });

    const scene = await until(
      (message) =>
        message.kind === 'scene' &&
        message.nodes.some((node) => node.elementId === 'overlay'),
    );

    assert.ok(scene.kind === 'scene');

    const overlay = scene.nodes.find((node) => node.elementId === 'overlay');
    const portal = scene.nodes.find((node) => node.id === overlay?.parentId);

    assert.deepEqual(
      { stamp: overlay?.stamp, text: overlay?.text },
      { stamp: 'src/Overlay.stories.tsx:6', text: 'open' },
    );
    // The old revision's portal container, a child of the frame's root.
    assert.equal(portal?.depth, 0);
    assert.ok(
      window.document.querySelector(
        '#root > [data-papercraft-portal] > #overlay',
      ),
    );

    channel.port1.postMessage({ kind: 'dispose' });
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(window.document.querySelector('#overlay'), null);
    assert.equal(window.document.body.children.length, 0);
    assert.deepEqual(invalid, []);
  } finally {
    channel.port1.close();
  }
});
