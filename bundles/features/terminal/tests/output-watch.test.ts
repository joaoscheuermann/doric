// The window's terminal streams over `terminal/v1.watchProject` (moved from
// the layout's `terminal-watch.test.ts`): the cases of the main process's
// former `terminal-events` suite, plus the reconnect and failure rules the
// stream form adds.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  type ConnectionStatus,
  ContractError,
  type Disposable,
  type StreamObserver,
} from 'bundle/contracts';

import type { TerminalSnapshotRead } from '../src/client/api.js';
import type {
  Terminal,
  TerminalOutputUpdate,
  TerminalUpdate,
} from '../src/client/domain/terminals.js';
import {
  createTerminalWatches,
  pendingOutputLimit,
  type TerminalStreamSource,
} from '../src/client/output-watch.js';
import type { TerminalWatchItem } from '../src/contracts/index.js';

interface OpenStream {
  readonly projectId: string;
  readonly observer: StreamObserver<TerminalWatchItem>;
  disposed: boolean;
}

class FakeTerminals implements TerminalStreamSource {
  readonly streams: OpenStream[] = [];

  watchProject(
    projectId: string,
    observer: StreamObserver<TerminalWatchItem>,
  ): Disposable {
    const stream: OpenStream = { projectId, observer, disposed: false };
    this.streams.push(stream);
    return {
      dispose: () => {
        stream.disposed = true;
      },
    };
  }

  get openStreams(): readonly OpenStream[] {
    return this.streams.filter((stream) => !stream.disposed);
  }

  /** The newest stream that is still open. */
  get open(): OpenStream {
    const stream = this.openStreams.at(-1);
    assert.ok(stream !== undefined, 'no open stream');
    return stream;
  }

  emit(item: TerminalWatchItem): void {
    this.open.observer.next(item);
  }

  /** Ends the newest open stream, as the provider or the bridge does. */
  end(error?: ContractError): void {
    const stream = this.open;
    stream.disposed = true;
    stream.observer.end?.(error);
  }
}

class FakeConnection {
  current: ConnectionStatus = 'connected';
  private readonly listeners = new Set<(status: ConnectionStatus) => void>();

  status(): ConnectionStatus {
    return this.current;
  }

  subscribe(listener: (status: ConnectionStatus) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => void this.listeners.delete(listener) };
  }

  report(status: ConnectionStatus): void {
    this.current = status;
    for (const listener of [...this.listeners]) listener(status);
  }
}

const terminal: Terminal = {
  id: 'terminal',
  projectId: 'project',
  threadId: 'thread',
  origin: 'agent',
  command: 'build',
  cwd: '/workspace',
  startedAt: '2026-10-03T00:00:00Z',
  timeoutMs: 1000,
  state: 'running',
  pty: false,
};

const snapshotOf = (output: string): TerminalSnapshotRead => ({
  terminal,
  output,
  offset: output.length,
  truncated: false,
});

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

const setup = (
  read: (id: string) => Promise<TerminalSnapshotRead> = async () =>
    snapshotOf(''),
) => {
  const terminals = new FakeTerminals();
  const connection = new FakeConnection();
  const timers: (() => void)[] = [];
  const watches = createTerminalWatches({
    terminals,
    snapshot: read,
    connection,
    schedule: (run) => {
      timers.push(run);
      return () => {
        const index = timers.indexOf(run);
        if (index >= 0) timers.splice(index, 1);
      };
    },
  });
  const fireTimers = () => {
    for (const run of timers.splice(0)) run();
  };
  return { terminals, connection, watches, fireTimers };
};

const listSnapshot = (
  items: readonly Terminal[],
  projectId = 'project',
): TerminalWatchItem => ({ kind: 'snapshot', projectId, terminals: items });

const output = (
  data: string,
  offset: number,
  at: { projectId?: string; terminalId?: string } = {},
): TerminalWatchItem => ({
  kind: 'output',
  output: {
    projectId: at.projectId ?? 'project',
    threadId: 'thread',
    terminalId: at.terminalId ?? 'terminal',
    data,
    offset,
  },
});

const disconnected = () =>
  new ContractError('disconnected', 'The bridge closed.');

describe('terminal output watch', () => {
  test('reconciles output received during the snapshot without duplicating overlapping text', async () => {
    let resolveRead!: (value: TerminalSnapshotRead) => void;
    let first = true;
    const { terminals, watches } = setup(() => {
      if (first) {
        first = false;
        return Promise.resolve(snapshotOf(''));
      }
      return new Promise((resolve) => {
        resolveRead = resolve;
      });
    });
    const updates: TerminalOutputUpdate[] = [];
    watches.watch('terminal', 0, (update) => void updates.push(update));
    await tick();

    terminals.emit(listSnapshot([terminal]));
    terminals.emit(output('hello world', 11));
    resolveRead(snapshotOf('hello'));
    await tick();

    assert.deepEqual(updates, [
      { kind: 'snapshot', data: 'hello', sequence: 5, truncated: false },
      { kind: 'output', data: ' world', sequence: 11 },
    ]);

    terminals.emit(output('secret', 17, { projectId: 'elsewhere' }));
    terminals.emit(output('other', 16, { terminalId: 'other' }));
    terminals.emit(output('hello world', 11));
    assert.equal(updates.length, 2);
    watches.close();
  });

  test('follows the stream of the Project the terminal belongs to', async () => {
    const { terminals, watches } = setup();
    watches.watch('terminal', 0, () => undefined);
    await tick();

    assert.deepEqual(
      terminals.openStreams.map((stream) => stream.projectId),
      ['project'],
    );
    watches.close();
  });

  test('a reconnect replaces the transcript and a stopped watch publishes no late read', async () => {
    let current = snapshotOf('first');
    const { terminals, connection, watches } = setup(async () => current);
    const updates: TerminalOutputUpdate[] = [];
    const stop = watches.watch(
      'terminal',
      0,
      (update) => void updates.push(update),
    );
    await tick();
    terminals.emit(listSnapshot([terminal]));
    await tick();

    connection.report('disconnected');
    terminals.end(disconnected());
    current = snapshotOf('first and second');
    connection.report('connected');
    terminals.emit(listSnapshot([terminal]));
    await tick();

    assert.deepEqual(updates.at(-1), {
      kind: 'snapshot',
      data: 'first and second',
      sequence: 16,
      truncated: false,
    });
    assert.ok(updates.every((update) => update.kind !== 'error'));

    terminals.emit(listSnapshot([terminal]));
    const count = updates.length;
    stop();
    await tick();
    assert.equal(updates.length, count);
    assert.equal(terminals.openStreams.length, 0);
  });

  test('subscribes again after a second when the connection stayed up', async () => {
    const { terminals, watches, fireTimers } = setup();
    watches.watch('terminal', 0, () => undefined);
    await tick();

    terminals.end(disconnected());
    assert.equal(terminals.openStreams.length, 0);
    fireTimers();

    assert.equal(terminals.openStreams.length, 1);
    watches.close();
  });

  test('subscribes again, reporting nothing, when the host generation serving the stream is lost', async () => {
    const { terminals, watches, fireTimers } = setup();
    const updates: TerminalOutputUpdate[] = [];
    watches.watch('terminal', 0, (update) => void updates.push(update));
    await tick();

    terminals.end(new ContractError('generation_lost', 'Generation 1 exited.'));
    fireTimers();

    assert.equal(terminals.openStreams.length, 1);
    assert.ok(updates.every((update) => update.kind !== 'error'));
    watches.close();
  });

  test('output after a gap reads the snapshot again', async () => {
    let current = snapshotOf('abc');
    const { terminals, watches } = setup(async () => current);
    const updates: TerminalOutputUpdate[] = [];
    watches.watch('terminal', 0, (update) => void updates.push(update));
    await tick();
    terminals.emit(listSnapshot([terminal]));
    await tick();

    current = snapshotOf('abcdefghij');
    terminals.emit(output('hij', 10));
    await tick();

    assert.deepEqual(updates.at(-1), {
      kind: 'snapshot',
      data: 'abcdefghij',
      sequence: 10,
      truncated: false,
    });
    watches.close();
  });

  test('output beyond the buffer limit during a snapshot reads it again', async () => {
    const reads: ((value: TerminalSnapshotRead) => void)[] = [];
    let first = true;
    const { terminals, watches } = setup(() => {
      if (first) {
        first = false;
        return Promise.resolve(snapshotOf(''));
      }
      return new Promise((resolve) => void reads.push(resolve));
    });
    const updates: TerminalOutputUpdate[] = [];
    watches.watch('terminal', 0, (update) => void updates.push(update));
    await tick();
    terminals.emit(listSnapshot([terminal]));

    const chunk = 'x'.repeat(pendingOutputLimit + 1);
    terminals.emit(output(chunk, chunk.length));
    assert.equal(reads.length, 2);

    // The first read is stale: only the newer one is published.
    reads[0]?.(snapshotOf('stale'));
    reads[1]?.(snapshotOf('fresh'));
    await tick();
    assert.deepEqual(
      updates.map((update) => (update.kind === 'error' ? '' : update.data)),
      ['fresh'],
    );
    watches.close();
  });

  test('a terminal that cannot be read reports that it is gone', async () => {
    const { watches } = setup(async () => {
      throw new Error('Doric could not complete the terminal request.');
    });
    const updates: TerminalOutputUpdate[] = [];
    watches.watch('terminal', 0, (update) => void updates.push(update));
    await tick();

    assert.deepEqual(updates, [
      { kind: 'error', message: 'The terminal is no longer available.' },
    ]);
  });

  test('a stream that fails reports the connection failure and stays ended', async () => {
    const { terminals, connection, watches, fireTimers } = setup();
    const updates: TerminalOutputUpdate[] = [];
    watches.watch('terminal', 0, (update) => void updates.push(update));
    await tick();

    terminals.end(new ContractError('replay_failed', 'No snapshot.'));
    connection.report('connected');
    fireTimers();

    assert.deepEqual(updates, [
      { kind: 'error', message: 'The terminal connection failed.' },
    ]);
    assert.equal(terminals.openStreams.length, 0);
  });

  test('a newer watch of the same terminal replaces the older one', async () => {
    const { terminals, watches } = setup(async () => snapshotOf('text'));
    const older: TerminalOutputUpdate[] = [];
    const newer: TerminalOutputUpdate[] = [];
    const stopOlder = watches.watch(
      'terminal',
      0,
      (update) => void older.push(update),
    );
    await tick();
    watches.watch('terminal', 0, (update) => void newer.push(update));
    await tick();

    terminals.emit(listSnapshot([terminal]));
    await tick();
    stopOlder();

    assert.deepEqual(older, []);
    assert.equal(newer.length, 1);
    assert.equal(terminals.openStreams.length, 1);
    watches.close();
  });
});

describe('Project terminal watch', () => {
  test('filters other Projects and stops its stream', () => {
    const { terminals, watches } = setup();
    const updates: TerminalUpdate[] = [];
    const stop = watches.watchProject(
      'project',
      (update) => void updates.push(update),
    );

    terminals.emit({
      kind: 'updated',
      terminal: { ...terminal, projectId: 'other' },
    });
    terminals.emit(listSnapshot([terminal], 'other'));
    terminals.emit(
      listSnapshot([terminal, { ...terminal, id: 'b', projectId: 'other' }]),
    );
    terminals.emit({
      kind: 'removed',
      projectId: 'other',
      threadId: 'thread',
      terminalId: 'terminal',
    });
    terminals.emit({
      kind: 'removed',
      projectId: 'project',
      threadId: 'thread',
      terminalId: 'terminal',
    });
    terminals.emit(output('ignored', 7));

    assert.deepEqual(updates, [
      { kind: 'snapshot', terminals: [terminal] },
      { kind: 'removed', terminalId: 'terminal' },
    ]);
    stop();
    assert.equal(terminals.openStreams.length, 0);
  });

  test('forwards updated terminals of its Project', () => {
    const { terminals, watches } = setup();
    const updates: TerminalUpdate[] = [];
    watches.watchProject('project', (update) => void updates.push(update));

    terminals.emit({
      kind: 'updated',
      terminal: { ...terminal, state: 'exited' },
    });

    assert.deepEqual(updates, [
      { kind: 'updated', terminal: { ...terminal, state: 'exited' } },
    ]);
    watches.close();
  });

  test('a record that fails the terminal check is reported, not forwarded', () => {
    const { terminals, watches } = setup();
    const updates: TerminalUpdate[] = [];
    watches.watchProject('project', (update) => void updates.push(update));
    const broken = { ...terminal, origin: 'robot' } as unknown as Terminal;

    terminals.emit(listSnapshot([broken]));
    terminals.emit({ kind: 'updated', terminal: broken });

    assert.deepEqual(updates, [
      { kind: 'error', message: 'The terminal list could not be read.' },
      { kind: 'error', message: 'The terminal could not be read.' },
    ]);
    watches.close();
  });

  test('a dropped connection is silent and the next snapshot replaces the list', () => {
    const { terminals, connection, watches } = setup();
    const updates: TerminalUpdate[] = [];
    watches.watchProject('project', (update) => void updates.push(update));
    terminals.emit(listSnapshot([terminal]));

    connection.report('disconnected');
    terminals.end(disconnected());
    connection.report('connected');
    terminals.emit(listSnapshot([]));

    assert.deepEqual(updates, [
      { kind: 'snapshot', terminals: [terminal] },
      { kind: 'snapshot', terminals: [] },
    ]);
    watches.close();
  });

  test('a failed stream reports the connection failure once', () => {
    const { terminals, connection, watches, fireTimers } = setup();
    const updates: TerminalUpdate[] = [];
    watches.watchProject('project', (update) => void updates.push(update));

    terminals.end(new ContractError('invalid_output', 'Bad item.'));
    connection.report('connected');
    fireTimers();

    assert.deepEqual(updates, [
      { kind: 'error', message: 'The terminal connection failed.' },
    ]);
    assert.equal(terminals.openStreams.length, 0);
  });

  test('a newer watch of the same Project silences the older listener', () => {
    const { terminals, watches } = setup();
    const older: TerminalUpdate[] = [];
    const newer: TerminalUpdate[] = [];
    watches.watchProject('project', (update) => void older.push(update));
    watches.watchProject('project', (update) => void newer.push(update));

    terminals.emit(listSnapshot([terminal]));

    assert.deepEqual(older, []);
    assert.equal(newer.length, 1);
    assert.equal(terminals.openStreams.length, 1);
    watches.close();
  });
});
