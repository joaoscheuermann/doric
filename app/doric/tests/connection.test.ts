import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  bindConnectionStatus,
  connectionStatusChannel,
  type ConnectionTarget,
  createConnectionState,
} from '../src/connection/ipc';
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
    this.listeners.get(event)?.forEach((listener) => listener());
  }
}

class FakeTarget implements ConnectionTarget {
  readonly messages: Array<{
    readonly channel: string;
    readonly status: ConnectionStatus;
  }> = [];
  private readonly listeners = new Map<string, Set<() => void>>();
  private destroyed = false;

  on(event: 'did-finish-load', listener: () => void): void {
    this.add(event, listener);
  }

  once(event: 'destroyed', listener: () => void): void {
    this.add(event, listener);
  }

  off(event: 'did-finish-load' | 'destroyed', listener: () => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  send(channel: string, status: ConnectionStatus): void {
    this.messages.push({ channel, status });
  }

  emit(event: 'did-finish-load' | 'destroyed'): void {
    if (event === 'destroyed') this.destroyed = true;
    this.listeners.get(event)?.forEach((listener) => listener());
    if (event === 'destroyed') this.listeners.delete(event);
  }

  private add(event: string, listener: () => void): void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
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

describe('connection renderer state', () => {
  test('keeps a deduplicated snapshot and supports unsubscribe', () => {
    const state = createConnectionState();
    const statuses: ConnectionStatus[] = [];
    const unsubscribe = state.subscribe((status) => statuses.push(status));

    state.update('connected');
    state.update('connected');
    unsubscribe();
    state.update('disconnected');

    assert.equal(state.status(), 'disconnected');
    assert.deepEqual(statuses, ['connected']);
  });
});

describe('connection window binding', () => {
  test('sends the current snapshot only after loading finishes', () => {
    const { socket, monitor } = setup();
    const target = new FakeTarget();
    bindConnectionStatus(target, monitor);

    socket.emit('connect');
    assert.deepEqual(target.messages, []);

    target.emit('did-finish-load');
    assert.deepEqual(target.messages, [
      { channel: connectionStatusChannel, status: 'connected' },
    ]);
  });

  test('forwards changes after load and cleans up when destroyed', () => {
    const { socket, monitor } = setup();
    const target = new FakeTarget();
    bindConnectionStatus(target, monitor);
    target.emit('did-finish-load');

    socket.emit('connect');
    target.emit('destroyed');
    socket.emit('disconnect');

    assert.deepEqual(target.messages, [
      { channel: connectionStatusChannel, status: 'disconnected' },
      { channel: connectionStatusChannel, status: 'connected' },
    ]);
  });
});
