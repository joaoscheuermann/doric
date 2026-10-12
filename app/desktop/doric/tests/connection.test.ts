import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  type ConnectionSocket,
  type ConnectionStatus,
  createConnectionMonitor,
} from '../src/connection/status';

type SocketEvent = 'connect' | 'disconnect' | 'connect_error';

class FakeSocket implements ConnectionSocket {
  connected = false;
  private readonly listeners = new Map<SocketEvent, Set<() => void>>();

  on(event: SocketEvent, listener: () => void): void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  off(event: SocketEvent, listener: () => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: SocketEvent): void {
    this.connected = event === 'connect';
    this.listeners.get(event)?.forEach((listener) => void listener());
  }
}

const setup = (connected = false) => {
  const socket = new FakeSocket();
  socket.connected = connected;
  let closes = 0;
  const monitor = createConnectionMonitor(socket, () => {
    closes += 1;
  });
  return { socket, monitor, closes: () => closes };
};

describe('connection monitor', () => {
  test('reflects the socket snapshot and publishes connection transitions', () => {
    const { socket, monitor } = setup();
    const statuses: ConnectionStatus[] = [];
    monitor.subscribe((status) => statuses.push(status));

    assert.equal(monitor.status(), 'disconnected');
    socket.emit('connect');
    assert.equal(monitor.status(), 'connected');
    assert.deepEqual(statuses, ['connected']);
  });

  test('deduplicates repeated disconnect signals', () => {
    const { socket, monitor } = setup(true);
    const statuses: ConnectionStatus[] = [];
    monitor.subscribe((status) => statuses.push(status));

    socket.emit('connect_error');
    socket.emit('disconnect');
    socket.emit('connect_error');

    assert.deepEqual(statuses, ['disconnected']);
  });

  test('continues publishing after a disconnect reconnect cycle', () => {
    const { socket, monitor } = setup(true);
    const statuses: ConnectionStatus[] = [];
    monitor.subscribe((status) => statuses.push(status));

    socket.emit('disconnect');
    socket.emit('connect');

    assert.equal(monitor.status(), 'connected');
    assert.deepEqual(statuses, ['disconnected', 'connected']);
  });

  test('close disconnects once and stops future publication', () => {
    const { socket, monitor, closes } = setup(true);
    const statuses: ConnectionStatus[] = [];
    monitor.subscribe((status) => statuses.push(status));

    monitor.close();
    monitor.close();
    socket.emit('connect');

    assert.equal(monitor.status(), 'disconnected');
    assert.deepEqual(statuses, ['disconnected']);
    assert.equal(closes(), 1);
  });
});
