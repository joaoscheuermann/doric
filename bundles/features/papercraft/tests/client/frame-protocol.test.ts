// PC2 (papercraft-openui.md D6, "Protocol 2"): the app validates each frame
// message with protocol 2, the papercraft program frame's: a repeatable
// `program`, scene nodes named by statement instead of a stamp, a bounded
// `errors` message and no `action`. A handshake of another number is dropped.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  connectMessage,
  frameMessage,
  frameMessageSchema,
  isHello,
} from '../../src/client/frame-protocol.js';

const box = { x: 0, y: 0, width: 10, height: 10 };
const node = (extra: Record<string, unknown> = {}) => ({
  id: 'n0',
  depth: 0,
  tag: 'div',
  classes: [],
  text: 'Save',
  bounds: box,
  ...extra,
});
const scene = (nodes: readonly unknown[]) => ({ kind: 'scene', nodes });
const errors = (count: number, message = 'Unknown component') => ({
  kind: 'errors',
  errors: Array.from({ length: count }, (_, index) => ({
    code: 'unknown-component',
    statementId: `s${String(index)}`,
    message,
  })),
});

test('PC2: under protocol 2 a scene node carries its statement and component', () => {
  const message = scene([node({ statement: 'save', component: 'Button' })]);

  assert.deepEqual(frameMessage(message, 2), message);
  assert.equal(frameMessageSchema(2).safeParse(message).success, true);
});

test('PC2: protocol 2 takes `ready` with 2 and every shared message any number of times', () => {
  const shared = [
    { kind: 'ready', protocol: 2 },
    { kind: 'mounted', mode: 'module', layout: 'padded' },
    { kind: 'size', width: 300, height: 120 },
    scene([node({ statement: 'root', component: 'Stack' })]),
    scene([node({ statement: 'root', component: 'Stack' })]),
    errors(1),
    errors(0),
    { kind: 'error', message: 'boom' },
  ];

  for (const message of shared) {
    assert.deepEqual(
      frameMessage(message, 2),
      message,
      JSON.stringify(message),
    );
  }
});

test('PC2: protocol 2 rejects a statement that fails its pattern and a node with `stamp`', () => {
  for (const bad of [
    node({ statement: '1save' }),
    node({ statement: 'save-button' }),
    node({ statement: `s${'x'.repeat(64)}` }),
    node({ component: 'Bad Name' }),
    node({ statement: 'save', stamp: 'src/App.tsx:4' }),
  ]) {
    assert.equal(frameMessage(scene([bad]), 2), undefined, JSON.stringify(bad));
  }
});

test('PC2: protocol 2 takes 50 errors and rejects 51, and takes a 1,024-character message but not 1,025', () => {
  assert.notEqual(frameMessage(errors(50), 2), undefined);
  assert.equal(frameMessage(errors(51), 2), undefined);
  assert.notEqual(frameMessage(errors(1, 'x'.repeat(1024)), 2), undefined);
  assert.equal(frameMessage(errors(1, 'x'.repeat(1025)), 2), undefined);
});

test('PC2: protocol 2 has no `action` message, and a `ready` of protocol 1 is dropped', () => {
  assert.equal(
    frameMessage({ kind: 'action', text: 'Tag the release', params: {} }, 2),
    undefined,
  );
  assert.equal(frameMessage({ kind: 'ready', protocol: 1 }, 2), undefined);
});

test("PC2: a `hello` of the other protocol's number is not one, and connectMessage(2) carries 2", () => {
  assert.equal(isHello({ papercraft: 2, kind: 'hello' }, 2), true);
  assert.equal(isHello({ papercraft: 1, kind: 'hello' }, 2), false);
  assert.deepEqual(connectMessage(2), { papercraft: 2, kind: 'connect' });
});

// PC2 (D25, stage 4): protocol 1 is gone, so protocol 2 is the default of
// every reader that is not told a protocol.
test('PC2: with no protocol given, a hello, a ready and a scene are read as protocol 2', () => {
  assert.equal(isHello({ papercraft: 2, kind: 'hello' }), true);
  assert.equal(isHello({ papercraft: 1, kind: 'hello' }), false);
  assert.deepEqual(frameMessage({ kind: 'ready', protocol: 2 }), {
    kind: 'ready',
    protocol: 2,
  });
  assert.equal(frameMessage({ kind: 'ready', protocol: 1 }), undefined);

  const named = scene([node({ statement: 'save', component: 'Button' })]);
  assert.deepEqual(frameMessage(named), named);
  assert.equal(
    frameMessage(scene([node({ stamp: 'src/checkout.html:12' })])),
    undefined,
  );
  assert.notEqual(frameMessage(errors(1)), undefined);
});
