// The modal's draw.io editor frame (spec "O modal do diagrama", Editar; plan
// §3.7, tests F1 and F2): the editor URL per theme and the editor's
// configuration (C7), and `EditorFrame` — one sandboxed iframe it never
// points anywhere itself, one client over it created at mount through
// `DiagramDrawing.createEditorClient` (faked at that boundary), callbacks
// that reach the latest props, and the client closed at unmount.

import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';

import type { Root } from 'react-dom/client';

import type {
  EditorClient,
  EditorEvent,
} from '../../src/client/editor-frame.js';
import { EDITOR_LOAD_TIMEOUT_MS } from '../../src/contracts/index.js';
import {
  editorFrame,
  fakeDrawing,
  loadClient,
  react,
} from './support/diagram-harness.js';
import { window } from './support/dom.js';

const LIGHT_URL =
  'https://drawio.doric.invalid/index.html?spin=1&stealth=1&lockdown=1&pwa=0&noSaveBtn=1&noExitBtn=1&saveAndExit=0&ui=min&dark=0&lang=pt-br&embed=1&proto=json&configure=1';
const DARK_URL =
  'https://drawio.doric.invalid/index.html?spin=1&stealth=1&lockdown=1&pwa=0&noSaveBtn=1&noExitBtn=1&saveAndExit=0&ui=min&dark=1&lang=pt-br&embed=1&proto=json&configure=1';
const CONFIG = {
  suppressNewWindows: true,
  compressXml: false,
  passThroughKeys: [{ key: 's', ctrl: true, command: 'save' }],
};

before(loadClient);

const roots: { root: Root; host: HTMLElement }[] = [];

afterEach(async () => {
  for (const { root, host } of roots.splice(0)) {
    await react.act(async () => root.unmount());
    host.remove();
  }
});

after(async () => {
  await window.happyDOM.abort();
  await window.happyDOM.close();
});

type FrameProps = Parameters<typeof editorFrame.EditorFrame>[0];

/** Renders `EditorFrame` with `props` into a fresh host; `render` re-renders it. */
const mountFrame = async (props: FrameProps) => {
  const { createRoot } = await import('react-dom/client');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const entry = { root, host };
  roots.push(entry);
  const render = (next: FrameProps) =>
    react.act(async () => root.render(<editorFrame.EditorFrame {...next} />));
  await render(props);

  return {
    host,
    render,
    unmount: async () => {
      roots.splice(roots.indexOf(entry), 1);
      await react.act(async () => root.unmount());
      host.remove();
    },
  };
};

test('F1: editorUrl is the embed URL with the theme, and EDITOR_CONFIG the spec configuration', () => {
  assert.equal(editorFrame.editorUrl('light'), LIGHT_URL);
  assert.equal(editorFrame.editorUrl('dark'), DARK_URL);
  assert.deepEqual(editorFrame.EDITOR_CONFIG, CONFIG);
});

test('F2: EditorFrame renders one sandboxed iframe it never points anywhere itself', async () => {
  const fake = fakeDrawing();
  const frame = await mountFrame({
    drawing: fake.drawing,
    theme: 'light',
    onInit: () => undefined,
    onEvent: () => undefined,
  });

  const iframes = [...frame.host.querySelectorAll('iframe')];
  assert.equal(iframes.length, 1);

  const iframe = iframes[0] as HTMLIFrameElement;
  assert.equal(iframe.getAttribute('data-testid'), 'drawio-editor-frame');
  assert.equal(iframe.getAttribute('title'), 'Editor de diagrama');
  assert.equal(
    iframe.getAttribute('sandbox'),
    'allow-scripts allow-same-origin',
  );
  // The fake client never navigates: any `src` would be the frame's own.
  assert.equal(iframe.getAttribute('src'), null);
});

test('F2: EditorFrame creates one client over its iframe with the theme URL, the config and the load timeout', async () => {
  const fake = fakeDrawing();
  const frame = await mountFrame({
    drawing: fake.drawing,
    theme: 'dark',
    onInit: () => undefined,
    onEvent: () => undefined,
  });

  assert.equal(fake.editor.clients.length, 1);

  const created = fake.editor.last();
  assert.equal(created.iframe, frame.host.querySelector('iframe'));
  assert.equal(created.options.url, DARK_URL);
  assert.deepEqual(created.options.config, CONFIG);
  assert.equal(created.options.requestTimeout, EDITOR_LOAD_TIMEOUT_MS);
});

test('F2: the client’s onInit and onEvent reach the latest props, without a second client', async () => {
  const fake = fakeDrawing();
  const heard: string[] = [];
  const props = (tag: string): FrameProps => ({
    drawing: fake.drawing,
    theme: 'light',
    onInit: (client: EditorClient) => {
      heard.push(`${tag}:init:${String(client === fake.editor.last().client)}`);
    },
    onEvent: (event: EditorEvent) => {
      heard.push(`${tag}:event:${event.event}`);
    },
  });
  const frame = await mountFrame(props('first'));
  await frame.render(props('second'));

  assert.equal(fake.editor.clients.length, 1);

  await fake.editor.init();
  await fake.editor.emit({ event: 'autosave', xml: '<mxfile/>' });

  assert.deepEqual(heard, ['second:init:true', 'second:event:autosave']);
});

test('F2: unmounting EditorFrame closes its client once', async () => {
  const fake = fakeDrawing();
  const frame = await mountFrame({
    drawing: fake.drawing,
    theme: 'light',
    onInit: () => undefined,
    onEvent: () => undefined,
  });

  assert.equal(fake.editor.last().closed, 0);

  await frame.unmount();

  assert.equal(fake.editor.clients.length, 1);
  assert.equal(fake.editor.last().closed, 1);
});
