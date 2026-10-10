// The desktop end of `/doric/bridge` over a fake Socket.IO socket (the
// network is the boundary): calls, the unavailable answers and the end of
// open streams when the connection drops.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { WireCall } from 'bundle/runtime';

import {
  type BridgeSocket,
  createHostBridge,
} from '../src/platform/bridge/host-bridge';

const fakeSocket = (connected = true) => {
  const listeners = new Map<string, ((...args: never[]) => void)[]>();
  const emitted: { event: string; message: Record<string, unknown> }[] = [];
  const socket: BridgeSocket & {
    connected: boolean;
    fire(event: string, payload?: unknown): void;
  } = {
    connected,
    on: (event, listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    emit: (event, message) => {
      emitted.push({ event, message: message as Record<string, unknown> });
    },
    connect: () => undefined,
    disconnect: () => undefined,
    fire: (event, payload) => {
      for (const listener of listeners.get(event) ?? []) {
        (listener as (payload: unknown) => void)(payload);
      }
    },
  };

  return { socket, emitted };
};

const wire = (deadline = 0): WireCall => ({
  caller: { bundleId: 'doric', version: '1.0.0', generation: 0 },
  trace: {
    traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
  },
  deadline,
  generation: 0,
});

const target = {
  contract: 'doric.catalog/v1',
  method: 'distribution',
  input: [],
};

describe('host bridge', () => {
  test('a call crosses as an envelope call and resolves with its result', async () => {
    const { socket, emitted } = fakeSocket();
    const bridge = createHostBridge(socket);
    const pending = bridge.call(target, wire());
    const sent = emitted[0];

    assert.equal(sent?.event, 'call');
    assert.equal(sent?.message.kind, 'call');
    assert.equal(sent?.message.contract, 'doric.catalog/v1');
    socket.fire('result', {
      kind: 'result',
      id: sent?.message.id,
      ok: true,
      output: { generation: 1 },
    });

    assert.deepEqual(await pending, { generation: 1 });
  });

  test('host errors keep their code', async () => {
    const { socket, emitted } = fakeSocket();
    const bridge = createHostBridge(socket);
    const pending = bridge.call(target, wire());

    socket.fire('result', {
      kind: 'result',
      id: emitted[0]?.message.id,
      ok: false,
      error: { code: 'not_found', message: 'unknown hash' },
    });

    await assert.rejects(pending, {
      code: 'not_found',
      message: 'unknown hash',
    });
  });

  test('a disconnected bridge and an elapsed deadline answer today’s unavailable message', async () => {
    const offline = createHostBridge(fakeSocket(false).socket);

    await assert.rejects(offline.call(target, wire()), {
      code: 'unavailable',
      message: 'Doric backend is unavailable.',
    });

    const { socket, emitted } = fakeSocket();
    const slow = createHostBridge(socket);

    await assert.rejects(slow.call(target, wire(Date.now() + 20)), {
      code: 'unavailable',
      message: 'Doric backend is unavailable.',
    });
    assert.deepEqual(
      emitted.map(({ event }) => event),
      ['call', 'cancel'],
    );
  });

  test('losing the connection fails pending calls and ends open streams with disconnected', async () => {
    const { socket } = fakeSocket();
    const bridge = createHostBridge(socket);
    const pending = bridge.call(target, wire());
    const ends: unknown[] = [];

    bridge.subscribe(
      { contract: 'doric.catalog/v1', method: 'watch', input: [] },
      wire(),
      { event: () => undefined, end: (error) => ends.push(error?.code) },
    );
    socket.connected = false;
    socket.fire('disconnect');

    await assert.rejects(pending, { code: 'unavailable' });
    assert.deepEqual(ends, ['disconnected']);
  });

  test('stream items arrive until the host ends the stream', () => {
    const { socket, emitted } = fakeSocket();
    const bridge = createHostBridge(socket);
    const items: unknown[] = [];
    let ended = false;

    bridge.subscribe(
      { contract: 'doric.catalog/v1', method: 'watch', input: [] },
      wire(),
      { event: (values) => items.push(...values), end: () => (ended = true) },
    );

    const id = emitted[0]?.message.id;

    assert.equal(emitted[0]?.event, 'subscribe');
    socket.fire('event', { kind: 'event', id, values: [{ generation: 2 }] });
    socket.fire('end', { kind: 'end', id });
    socket.fire('event', { kind: 'event', id, values: [{ generation: 3 }] });

    assert.deepEqual(items, [{ generation: 2 }]);
    assert.equal(ended, true);
  });
});
