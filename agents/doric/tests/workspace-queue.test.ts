import assert from 'node:assert/strict';
import test from 'node:test';

import type { SandboxExecResult } from 'sandbox';

import { createWorkspaceService } from '../src/lib/workspace/service.js';
import { deferred, fakeSandbox, pool, workspace } from './helpers/workspace.js';

void test('edits preserve FIFO and original receipts, reject stale versions and execute the latest text', {
  timeout: 5000,
}, async () => {
  const harness = workspace();
  const started = deferred();
  const release = deferred();
  const drained = deferred();
  const ran: string[] = [];
  const service = createWorkspaceService({
    ...harness.dependencies,
    pool: pool(undefined, fakeSandbox()),
    execute: async ({ job }) => {
      ran.push(job.prompt);
      if (job.prompt === 'current') {
        started.resolve();
        await release.promise;
      }
      if (job.prompt === 'last') drained.resolve();
      return 'done';
    },
  });
  try {
    const project = await service.projects.create('Project');
    const created = await service.threads.create(project.id, 'Thread');
    assert.equal(created.status, 'created');
    if (created.status !== 'created') return;
    const id = created.thread.id;
    const active = await service.threads.prompt(id, 'current');
    assert.equal(active.status, 'accepted');
    if (active.status !== 'accepted') return;
    await started.promise;
    const original = 'Full text beyond the preview. '.repeat(30);
    const pending = await service.threads.prompt(id, original);
    assert.equal(pending.status, 'accepted');
    if (pending.status !== 'accepted') return;
    const detail = await service.threads.queuedPrompt(id, pending.promptId);
    assert.equal(detail?.text, original);
    assert.equal(detail?.editable, true);
    assert.ok(detail);
    await service.threads.prompt(id, 'last');
    const saved = await service.threads.editQueued(
      id,
      pending.promptId,
      'edited input',
      detail.revision,
    );
    assert.equal(saved.status, 'updated');
    if (saved.status !== 'updated') return;
    assert.ok(saved.prompt.revision > detail.revision);
    assert.equal(
      (
        await service.threads.editQueued(
          id,
          pending.promptId,
          'stale input',
          detail.revision,
        )
      ).status,
      'conflict',
    );
    assert.equal(
      (
        await service.threads.editQueued(
          id,
          active.promptId,
          'change current',
          0,
        )
      ).status,
      'not_editable',
    );
    assert.equal(
      (
        await service.threads.editQueued(
          id,
          pending.promptId,
          '   ',
          saved.prompt.revision,
        )
      ).status,
      'invalid_prompt',
    );
    assert.deepEqual(
      (await service.threads.queue(id))?.items.map((item) => item.preview),
      ['edited input', 'last'],
    );
    assert.equal(
      (await service.threads.queuedPrompt(id, pending.promptId))?.promptId,
      pending.promptId,
    );
    const accepted = harness.events.find(
      (event) =>
        event.promptId === pending.promptId && event.type === 'prompt.accepted',
    );
    assert.ok(accepted);
    assert.equal((accepted.event as { text: string }).text, original);
    release.resolve();
    await drained.promise;
    await harness.threadState(id, 'ready');
    assert.deepEqual(ran, ['current', 'edited input', 'last']);
    assert.equal(
      (
        await service.threads.editQueued(
          id,
          pending.promptId,
          'too late',
          saved.prompt.revision,
        )
      ).status,
      'unknown_prompt',
    );
  } finally {
    release.resolve();
    await service.dispose();
  }
});

void test('removing queued and paused inputs preserves history and the remaining FIFO, but refuses the active input', {
  timeout: 5000,
}, async () => {
  const harness = workspace();
  const started = deferred();
  const drained = deferred();
  const ran: string[] = [];
  const service = createWorkspaceService({
    ...harness.dependencies,
    pool: pool(undefined, fakeSandbox()),
    execute: async ({ job, signal }) => {
      ran.push(job.prompt);
      if (job.prompt === 'current') {
        started.resolve();
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
      } else drained.resolve();
      return 'done';
    },
  });
  try {
    const project = await service.projects.create('Project');
    const created = await service.threads.create(project.id, 'Thread');
    if (created.status !== 'created') throw new Error('Thread unavailable');
    const id = created.thread.id;
    const current = await service.threads.prompt(id, 'current');
    if (current.status !== 'accepted') throw new Error('Prompt unavailable');
    await started.promise;
    const remove = await service.threads.prompt(id, 'remove');
    if (remove.status !== 'accepted') throw new Error('Prompt unavailable');
    await service.threads.prompt(id, 'keep');
    assert.equal(
      (await service.threads.queue(id))?.current?.promptId,
      current.promptId,
    );
    assert.equal(
      await service.threads.removeQueued(id, current.promptId),
      'busy',
    );
    assert.equal(
      await service.threads.removeQueued(id, remove.promptId),
      'removed',
    );
    assert.equal(
      await service.threads.removeQueued(id, remove.promptId),
      'removed',
    );
    assert.deepEqual(
      (await service.threads.queue(id))?.items.map((item) => item.preview),
      ['keep'],
    );
    await service.threads.interrupt(id, current.promptId);
    await harness.threadState(id, 'ready');
    assert.equal(
      await service.threads.removeQueued(id, current.promptId),
      'removed',
    );
    assert.equal((await service.threads.queue(id))?.current, undefined);
    assert.equal((await service.threads.queue(id))?.paused, true);
    await service.threads.resumeQueue(id);
    await drained.promise;
    await harness.threadState(id, 'ready');
    assert.deepEqual(ran, ['current', 'keep']);
    assert.ok(
      harness.events.some(
        (event) =>
          event.promptId === remove.promptId &&
          event.type === 'prompt.accepted',
      ),
    );
  } finally {
    await service.dispose();
  }
});

void test('Stop closes dispatch before abort, stays idempotent, and resumes the interrupted input before the FIFO', {
  timeout: 5000,
}, async () => {
  const harness = workspace();
  const started = deferred();
  const terminalFinished = deferred<SandboxExecResult>();
  const terminalQueued = deferred();
  const aborted = deferred();
  const settle = deferred();
  const drained = deferred();
  const ran: string[] = [];
  const service = createWorkspaceService({
    ...harness.dependencies,
    publisher: {
      ...harness.dependencies.publisher,
      event: (event) => {
        harness.dependencies.publisher.event(event);
        if (
          event.type === 'prompt.accepted' &&
          (event.event as { source?: { kind: string } }).source?.kind ===
            'terminal'
        )
          terminalQueued.resolve();
      },
    },
    pool: pool(undefined, {
      ...fakeSandbox(),
      start: async () => ({
        result: terminalFinished.promise,
        write: async () => undefined,
        resize: async () => undefined,
        terminate: async () => undefined,
      }),
    }),
    execute: async ({ host, job, signal }) => {
      ran.push(job.source.kind === 'terminal' ? 'late result' : job.prompt);
      if (ran.length === 1) {
        signal.addEventListener('abort', () => aborted.resolve(), {
          once: true,
        });
        if (host.terminals === undefined)
          throw new Error('Terminals are unavailable.');

        await host.terminals.run({
          command: 'echo late',
          cwd: '/workspace',
          timeoutMs: 0,
          background: true,
        });
        started.resolve();
        await settle.promise;
      }
      if (job.source.kind === 'terminal') drained.resolve();
      return 'done';
    },
  });
  try {
    const project = await service.projects.create('Project');
    const created = await service.threads.create(project.id, 'Thread');
    assert.equal(created.status, 'created');
    if (created.status !== 'created') throw new Error('Thread unavailable');
    const id = created.thread.id;
    const active = await service.threads.prompt(id, 'active');
    assert.equal(active.status, 'accepted');
    await started.promise;
    await service.threads.prompt(id, 'first');
    await service.threads.prompt(id, 'second');
    const before = await service.threads.queue(id);
    assert.deepEqual(
      before?.items.map((item) => item.preview),
      ['first', 'second'],
    );
    const lifecycle = () =>
      harness.events.filter(
        (event) =>
          event.threadId === id &&
          [
            'prompt.accepted',
            'prompt.queued',
            'prompt.started',
            'prompt.finished',
          ].includes(event.type),
      );
    assert.deepEqual(
      lifecycle().map((event) => event.type),
      [
        'prompt.accepted',
        'prompt.started',
        'prompt.accepted',
        'prompt.queued',
        'prompt.accepted',
        'prompt.queued',
      ],
    );
    const firstReceipt = lifecycle().find(
      (event) => event.type === 'prompt.queued',
    );
    assert.ok(firstReceipt);

    // A stale prompt id from the display must still stop this Thread's dispatcher.
    assert.equal(
      await service.threads.interrupt(id, 'stale-prompt'),
      'interrupted',
    );
    await aborted.promise;
    const stopping = await service.threads.queue(id);
    assert.equal(stopping?.stopping, true);
    assert.equal(stopping?.paused, true);
    assert.equal((await service.threads.resumeQueue(id)).status, 'busy');
    await service.threads.interrupt(id, 'stale-prompt');
    assert.equal(
      (await service.threads.queue(id))?.revision,
      stopping?.revision,
    );
    terminalFinished.resolve({
      stdout: 'late',
      stderr: '',
      exitCode: 0,
      stdoutBytes: new Uint8Array(),
      stderrBytes: new Uint8Array(),
    });
    await terminalQueued.promise;
    settle.resolve();
    await harness.threadState(id, 'ready');
    const paused = await service.threads.queue(id);
    assert.equal(paused?.stopping, false);
    assert.equal(paused?.resumable?.preview, 'active');
    assert.deepEqual(
      paused?.items.map((item) => item.preview),
      ['first', 'second', 'echo late'],
    );
    assert.deepEqual(ran, ['active']);

    assert.equal((await service.threads.resumeQueue(id)).status, 'resumed');
    await drained.promise;
    await harness.threadState(id, 'ready');
    assert.deepEqual(ran, [
      'active',
      'active',
      'first',
      'second',
      'late result',
    ]);
    const history = lifecycle();
    const dispatched = history.find(
      (event) =>
        event.promptId === firstReceipt.promptId &&
        event.type === 'prompt.started',
    );
    assert.ok(dispatched);
    const priorFinished = history.find(
      (event) =>
        event.promptId === active.promptId && event.type === 'prompt.finished',
    );
    assert.ok(priorFinished);
    assert.ok(firstReceipt.sequence < priorFinished.sequence);
    assert.ok(priorFinished.sequence < dispatched.sequence);
    assert.equal(
      history.filter(
        (event) =>
          event.promptId === firstReceipt.promptId &&
          event.type === 'prompt.accepted',
      ).length,
      1,
    );
    const empty = await service.threads.queue(id);
    assert.equal(empty?.paused, false);
    assert.equal(empty?.resumable, undefined);
    assert.deepEqual(empty?.items, []);
  } finally {
    settle.resolve();
    await service.dispose();
  }
});

void test('new queued inputs preserve the interrupted prompt and resume it before the FIFO', {
  timeout: 5000,
}, async () => {
  const harness = workspace();
  const started = deferred();
  const drained = deferred();
  const ran: string[] = [];
  const service = createWorkspaceService({
    ...harness.dependencies,
    pool: pool(undefined, fakeSandbox()),
    execute: async ({ job, signal }) => {
      ran.push(job.prompt);
      if (job.prompt === 'old' && ran.length === 1) {
        started.resolve();
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
      }
      if (job.prompt === 'second queued') drained.resolve();
      return 'done';
    },
  });
  try {
    const project = await service.projects.create('Project');
    const created = await service.threads.create(project.id, 'Thread');
    if (created.status !== 'created') throw new Error('Thread unavailable');
    const id = created.thread.id;
    const old = await service.threads.prompt(id, 'old');
    if (old.status !== 'accepted') throw new Error('Prompt unavailable');
    await started.promise;
    await service.threads.interrupt(id, old.promptId);
    await harness.threadState(id, 'ready');
    await service.threads.prompt(id, 'first queued');
    await service.threads.prompt(id, 'second queued');
    const queue = await service.threads.queue(id);
    assert.equal(queue?.paused, true);
    assert.equal(queue?.resumable?.promptId, old.promptId);
    assert.deepEqual(
      queue?.items.map((item) => item.preview),
      ['first queued', 'second queued'],
    );
    assert.deepEqual(ran, ['old']);
    await service.threads.resumeQueue(id);
    await drained.promise;
    await harness.threadState(id, 'ready');
    assert.deepEqual(ran, ['old', 'old', 'first queued', 'second queued']);
  } finally {
    await service.dispose();
  }
});
