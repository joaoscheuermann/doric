import assert from 'node:assert/strict';
import { test } from 'node:test';

import { push } from '../src/platform/windows/push';

const payload = { type: 'event' as const, id: 'stream', event: [] };

test('delivers through the current frame and skips detached or destroyed frames', () => {
  const sent: unknown[] = [];
  const frame = {
    url: 'doric://app/',
    detached: false,
    isDestroyed: () => false,
    send: (_channel: string, value: unknown) => sent.push(value),
  };
  const target = {
    isDestroyed: () => false,
    mainFrame: frame,
    send: () => assert.fail('must send through the frame'),
  };
  push(target, payload);
  frame.detached = true;
  push(target, payload);
  frame.detached = false;
  frame.isDestroyed = () => true;
  push(target, payload);
  assert.deepEqual(sent, [payload]);
});

test('tolerates frame disposal during send but preserves unrelated failures', () => {
  const target = {
    isDestroyed: () => false,
    send: () => {
      throw new Error(
        'Render frame was disposed before WebFrameMain could be accessed',
      );
    },
  };
  assert.doesNotThrow(() => push(target, payload));
  target.send = () => {
    throw new Error('invalid payload');
  };
  assert.throws(() => push(target, payload), /invalid payload/);
});
