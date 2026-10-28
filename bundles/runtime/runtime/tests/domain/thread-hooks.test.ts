import assert from 'node:assert/strict';
import test from 'node:test';

import type { SteerInput } from '../../src/contracts/executor.js';
import type { CwdChanged, PromptStarted } from '../../src/contracts/hooks.js';
import { fakeSandbox } from '../support/sandbox.js';
import { createHarness, deferred, type Harness } from './support/harness.js';

/*
 * runtime.hooks/v1 1.2.0 and runtime.threads/v1 1.5.0: a bundle hears that a
 * prompt started and that a Thread's working directory moved, and gives the
 * Thread an instruction of its own. Both hooks are awaited, so an instruction
 * given from a handler is waiting at the run's next safe point.
 */

/** What a handler passes; the provider names the calling bundle itself. */
const instruction = {
  bundleId: 'forged',
  reason: 'coding-workflow',
} as const;

const thread = async (harness: Harness) => {
  const project = await harness.service.projects.create('Project');
  await harness.projectState(project.id, 'ready');
  const created = await harness.service.threads.create(project.id, 'Thread');
  if (created.status !== 'created') throw new Error('Thread unavailable');
  return created.thread;
};

void test('an instruction given when a prompt starts is the run’s first steer, named after the calling bundle', {
  timeout: 5000,
}, async (t) => {
  const taken = deferred<readonly SteerInput[]>();
  const started: PromptStarted[] = [];
  const harness: Harness = createHarness({
    onHook: async (hook, input) => {
      if (hook !== 'onPromptStartedHook') return;
      const value = input as PromptStarted;
      started.push(value);
      await harness.service.threads.instruct(
        value.threadId,
        'Follow the workflow.',
        instruction,
        { promptId: value.promptId },
      );
    },
    execute: async (run) => {
      taken.resolve((await run.session.steers?.()) ?? []);
      return 'done';
    },
  });
  t.after(() => harness.dispose());
  const created = await thread(harness);

  const accepted = await harness.service.threads.prompt(created.id, 'Fix it.');
  assert.ok(accepted.status === 'accepted');

  assert.deepEqual(await taken.promise, [
    {
      prompt: 'Follow the workflow.',
      // `consumer` is the bundle that called runtime.threads/v1.
      source: {
        kind: 'bundle',
        bundleId: 'consumer',
        reason: 'coding-workflow',
      },
    },
  ]);
  assert.deepEqual(started, [
    {
      projectId: created.projectId,
      threadId: created.id,
      promptId: accepted.promptId,
      source: { kind: 'user' },
      cwd: '/workspace',
    },
  ]);
});

void test('a running prompt that moves into a repository hears it with both directories, and takes an instruction after the move', {
  timeout: 5000,
}, async (t) => {
  const changes: CwdChanged[] = [];
  const taken = deferred<readonly SteerInput[]>();
  let promptId = '';
  const harness: Harness = createHarness({
    sandbox: {
      sandbox: fakeSandbox({
        entries: [{ path: 'alpha' }],
        repositories: [
          { path: 'alpha', git: { status: '# branch.head main' } },
        ],
      }) as never,
    },
    onHook: async (hook, input) => {
      if (hook !== 'onThreadCwdChangedHook') return;
      const value = input as CwdChanged;
      changes.push(value);
      if (value.promptId !== undefined)
        await harness.service.threads.instruct(
          value.threadId,
          'Follow the workflow.',
          instruction,
          { promptId: value.promptId },
        );
    },
    execute: async (run) => {
      promptId = run.job.id;
      await harness.service.threads.setCwd(run.thread.id, '/workspace/alpha');
      // The tool batch that moved it is over: its safe point.
      taken.resolve((await run.session.steers?.()) ?? []);
      return 'done';
    },
  });
  t.after(() => harness.dispose());
  const created = await thread(harness);

  await harness.service.threads.prompt(created.id, 'Fix it.');

  assert.deepEqual(
    (await taken.promise).map(({ prompt }) => prompt),
    ['Follow the workflow.'],
  );
  assert.deepEqual(changes[0], {
    projectId: created.projectId,
    threadId: created.id,
    promptId,
    cwd: '/workspace/alpha',
    cwdRepo: 'git',
    previous: { cwd: '/workspace' },
  });
});

void test('an agent Thread takes a bundle’s instruction the reader may not give it', {
  timeout: 5000,
}, async (t) => {
  const spawned = deferred<string>();
  const release = deferred();
  const harness = createHarness({
    execute: async ({ job, tools }) => {
      if (job.prompt === 'parent') {
        spawned.resolve((await tools.threads.spawn('do the task')).threadId);
        await release.promise;
      }
      return 'done';
    },
  });
  t.after(() => harness.dispose());
  const created = await thread(harness);
  await harness.service.threads.prompt(created.id, 'parent');
  const child = await spawned.promise;

  assert.deepEqual(
    await harness.service.threads.steer(child, 'sideways', { promptId: 'x' }),
    { status: 'forbidden' },
  );
  const instructed = await harness.service.threads.instruct(
    child,
    'Follow the workflow.',
    instruction,
    {},
  );
  assert.ok(
    instructed.status === 'steered' || instructed.status === 'queued',
    instructed.status,
  );

  release.resolve();
});

void test('a standing instruction keeps its retain mark on the source the run reads', {
  timeout: 5000,
}, async (t) => {
  const taken = deferred<readonly SteerInput[]>();
  const harness: Harness = createHarness({
    onHook: async (hook, input) => {
      if (hook !== 'onPromptStartedHook') return;
      const value = input as PromptStarted;
      await harness.service.threads.instruct(
        value.threadId,
        'Follow the workflow.',
        { ...instruction, retain: true },
        { promptId: value.promptId },
      );
    },
    execute: async (run) => {
      taken.resolve((await run.session.steers?.()) ?? []);
      return 'done';
    },
  });
  t.after(() => harness.dispose());
  const created = await thread(harness);

  await harness.service.threads.prompt(created.id, 'Fix it.');

  assert.deepEqual((await taken.promise)[0]?.source, {
    kind: 'bundle',
    bundleId: 'consumer',
    reason: 'coding-workflow',
    retain: true,
  });
});

void test('a location that finds a new repository publishes the record and fires the cwd hook once', {
  timeout: 5000,
}, async (t) => {
  const changes: CwdChanged[] = [];
  const updates: unknown[] = [];
  const counts: { updates: number; changes: number }[] = [];
  const finished = deferred();
  const plain = fakeSandbox({ entries: [{ path: 'alpha' }] });
  const repository = fakeSandbox({
    entries: [{ path: 'alpha' }],
    repositories: [{ path: 'alpha', git: { status: '# branch.head main' } }],
  });
  const state = { current: plain };
  const handle = fakeSandbox();
  handle.exec = (input) => state.current.exec(input);
  let promptId = '';
  const harness: Harness = createHarness({
    sandbox: { sandbox: handle as never },
    onHook: async (hook, input) => {
      if (hook === 'onThreadCwdChangedHook') changes.push(input as CwdChanged);
    },
    execute: async ({ job, tools }) => {
      try {
        promptId = job.id;
        // The prompt creates a repository where it stands, without moving.
        state.current = repository;
        changes.length = 0;
        updates.length = 0;
        await tools.workspace.location();
        counts.push({ updates: updates.length, changes: changes.length });
        await tools.workspace.location();
        counts.push({ updates: updates.length, changes: changes.length });
      } finally {
        finished.resolve();
      }
      return 'done';
    },
  });
  t.after(() => harness.dispose());
  harness.listen((notice) => {
    // A prompt's own status changes publish the record too; only a record
    // carrying the new hint is the location's publication.
    if (notice.kind === 'threadUpdated' && notice.value.cwdRepo === 'git')
      updates.push(notice.value);
  });
  const created = await thread(harness);
  const moved = await harness.service.threads.setCwd(created.id, 'alpha');
  assert.ok(moved.status === 'updated' && moved.thread.cwdRepo === undefined);

  await harness.service.threads.prompt(created.id, 'git init');
  await finished.promise;

  assert.deepEqual(counts, [
    { updates: 1, changes: 1 },
    { updates: 1, changes: 1 },
  ]);
  assert.equal((updates[0] as { cwdRepo?: string }).cwdRepo, 'git');
  assert.deepEqual(changes, [
    {
      projectId: created.projectId,
      threadId: created.id,
      promptId,
      cwd: '/workspace/alpha',
      cwdRepo: 'git',
      previous: { cwd: '/workspace/alpha' },
    },
  ]);
});
