// The selected Project's live tree over `runtime/v1.watchProject`: the
// cases of the main process's former `project-events` suite, plus the
// reconnect rules the stream form adds.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  type ConnectionStatus,
  ContractError,
  type Disposable,
  type StreamObserver,
} from 'bundle/contracts';
import type {
  Project,
  ProjectWatchInput,
  ProjectWatchItem,
  Thread,
} from 'runtime/contracts';

import {
  createProjectWatch,
  type ProjectWatchSource,
} from '../src/client/api/project-watch.js';
import type { ProjectUpdate } from '../src/client/domain/workspace.js';

interface OpenStream {
  readonly input: ProjectWatchInput;
  readonly observer: StreamObserver<ProjectWatchItem>;
  disposed: boolean;
}

class FakeRuntime implements ProjectWatchSource {
  readonly streams: OpenStream[] = [];

  watchProject(
    input: ProjectWatchInput,
    observer: StreamObserver<ProjectWatchItem>,
  ): Disposable {
    const stream: OpenStream = { input, observer, disposed: false };
    this.streams.push(stream);
    return {
      dispose: () => {
        stream.disposed = true;
      },
    };
  }

  /** The newest stream that is still open. */
  get open(): OpenStream {
    const stream = this.streams.at(-1);
    assert.ok(stream !== undefined && !stream.disposed, 'no open stream');
    return stream;
  }

  emit(item: ProjectWatchItem): void {
    this.open.observer.next(item);
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

const setup = () => {
  const runtime = new FakeRuntime();
  const connection = new FakeConnection();
  const timers: (() => void)[] = [];
  const watch = createProjectWatch({
    runtime,
    connection,
    schedule: (run) => {
      timers.push(run);
      return () => {
        const index = timers.indexOf(run);
        if (index >= 0) timers.splice(index, 1);
      };
    },
  });
  const updates: ProjectUpdate[] = [];
  const onUpdate = (update: ProjectUpdate) => void updates.push(update);
  const fireTimers = () => {
    for (const run of timers.splice(0)) run();
  };
  return { runtime, connection, watch, updates, onUpdate, fireTimers };
};

const project: Project = {
  id: 'project-id',
  name: 'Project',
  state: 'ready',
  configRevision: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const thread: Thread = {
  id: 'thread-id',
  name: 'Main',
  projectId: 'project-id',
  state: 'ready',
  lastSequence: 0,
  cwd: '/workspace',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const snapshot = (
  threads: readonly Thread[],
  projectId = 'project-id',
): ProjectWatchItem => ({
  kind: 'snapshot',
  projectId,
  project: { ...project, id: projectId },
  threads,
  terminals: [],
});

const kinds = (updates: readonly ProjectUpdate[]) =>
  updates.map((update) => update.kind);

describe('Project watch', () => {
  test('forwards the Project snapshot before live Thread updates', () => {
    const { runtime, watch, updates, onUpdate } = setup();
    watch.watch('project-id', onUpdate);

    runtime.emit(snapshot([thread]));
    runtime.emit({
      kind: 'thread-updated',
      thread: { ...thread, name: 'Child' },
    });

    assert.deepEqual(runtime.open.input, { projectId: 'project-id' });
    assert.deepEqual(kinds(updates), ['snapshot', 'thread-updated']);
    assert.deepEqual(updates[0], {
      kind: 'snapshot',
      snapshot: { projectId: 'project-id', project, threads: [thread] },
    });
  });

  test('forwards Thread and Project lifecycle notices', () => {
    const { runtime, watch, updates, onUpdate } = setup();
    watch.watch('project-id', onUpdate);

    runtime.emit({
      kind: 'thread-deleted',
      projectId: 'project-id',
      threadId: 'thread-id',
    });
    runtime.emit({
      kind: 'project-updated',
      project: { ...project, name: 'Renamed' },
    });
    runtime.emit({ kind: 'project-deleted', projectId: 'project-id' });

    assert.deepEqual(kinds(updates), [
      'thread-deleted',
      'project-updated',
      'project-deleted',
    ]);
    assert.deepEqual(updates[0], {
      kind: 'thread-deleted',
      projectId: 'project-id',
      threadId: 'thread-id',
    });
  });

  test('ignores every update of another Project', () => {
    const { runtime, watch, updates, onUpdate } = setup();
    watch.watch('project-id', onUpdate);

    runtime.emit(snapshot([thread], 'other-project'));
    runtime.emit({
      kind: 'thread-updated',
      thread: { ...thread, projectId: 'other-project' },
    });
    runtime.emit({
      kind: 'thread-deleted',
      projectId: 'other-project',
      threadId: 'thread-id',
    });
    runtime.emit({
      kind: 'project-updated',
      project: { ...project, id: 'other-project' },
    });
    runtime.emit({ kind: 'project-deleted', projectId: 'other-project' });

    assert.deepEqual(updates, []);
  });

  test('a dropped connection reports nothing and resubscribes for a fresh snapshot once connected', () => {
    const { runtime, connection, watch, updates, onUpdate } = setup();
    watch.watch('project-id', onUpdate);
    runtime.emit(snapshot([thread]));

    connection.report('disconnected');
    runtime.open.observer.end?.(
      new ContractError('disconnected', 'The host bridge disconnected.'),
    );
    assert.deepEqual(kinds(updates), ['snapshot']);

    connection.report('connected');
    runtime.emit(snapshot([thread, { ...thread, id: 'child' }]));

    assert.deepEqual(kinds(updates), ['snapshot', 'snapshot']);
    const last = updates.at(-1);
    assert.equal(
      last?.kind === 'snapshot' ? last.snapshot.threads.length : 0,
      2,
    );
  });

  test('a stream dropped while the connection stays up resubscribes after a delay', () => {
    const { runtime, watch, updates, onUpdate, fireTimers } = setup();
    watch.watch('project-id', onUpdate);

    runtime.open.observer.end?.(
      new ContractError('unavailable', 'Doric backend is unavailable.'),
    );
    fireTimers();
    runtime.emit(snapshot([thread]));

    assert.deepEqual(kinds(updates), ['snapshot']);
  });

  test('a stream whose host generation was lost resubscribes silently for a fresh snapshot', () => {
    const { runtime, watch, updates, onUpdate, fireTimers } = setup();
    watch.watch('project-id', onUpdate);

    runtime.open.observer.end?.(
      new ContractError('generation_lost', 'Generation 1 exited.'),
    );
    fireTimers();
    runtime.emit(snapshot([thread]));

    assert.deepEqual(kinds(updates), ['snapshot']);
  });

  test('a failed stream reports only the fixed message and stays ended', () => {
    const { runtime, connection, watch, updates, onUpdate, fireTimers } =
      setup();
    watch.watch('project-id', onUpdate);
    const failed = runtime.open;

    failed.observer.end?.(
      new ContractError('internal', 'The snapshot could not be loaded.'),
    );
    connection.report('disconnected');
    connection.report('connected');
    fireTimers();

    assert.deepEqual(updates, [
      { kind: 'error', message: 'The Project event stream failed.' },
    ]);
    assert.equal(runtime.streams.length, 1);
  });

  test('an item the bridge rejects ends the stream with the fixed message', () => {
    const { runtime, watch, updates, onUpdate } = setup();
    watch.watch('project-id', onUpdate);

    runtime.open.observer.end?.(
      new ContractError('invalid_output', 'Invalid stream item.'),
    );

    assert.deepEqual(updates, [
      { kind: 'error', message: 'The Project event stream failed.' },
    ]);
  });

  test('watching another Project replaces the previous watch', () => {
    const { runtime, watch, updates, onUpdate } = setup();
    watch.watch('first-project', onUpdate);
    const first = runtime.open;
    watch.watch('second-project', onUpdate);

    assert.equal(first.disposed, true);
    assert.deepEqual(runtime.open.input, { projectId: 'second-project' });
    first.observer.next({
      kind: 'thread-updated',
      thread: { ...thread, projectId: 'first-project' },
    });
    assert.deepEqual(updates, []);
  });

  test('a stopped watch delivers nothing more and a stale stop keeps the current watch', () => {
    const { runtime, watch, updates, onUpdate } = setup();
    const stopFirst = watch.watch('project-id', onUpdate);
    const stopSecond = watch.watch('project-id', onUpdate);

    stopFirst();
    runtime.emit({ kind: 'thread-updated', thread });
    assert.deepEqual(kinds(updates), ['thread-updated']);

    const current = runtime.open;
    stopSecond();
    assert.equal(current.disposed, true);
    current.observer.next({ kind: 'thread-updated', thread });
    assert.deepEqual(kinds(updates), ['thread-updated']);
  });

  test('close stops the current watch and is idempotent', () => {
    const { runtime, connection, watch, updates, onUpdate } = setup();
    watch.watch('project-id', onUpdate);
    const current = runtime.open;
    current.observer.end?.(
      new ContractError('disconnected', 'The host bridge disconnected.'),
    );

    watch.close();
    watch.close();
    connection.report('connected');

    assert.equal(runtime.streams.length, 1);
    assert.deepEqual(updates, []);
  });
});
