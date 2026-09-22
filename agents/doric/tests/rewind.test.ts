import assert from 'node:assert/strict';
import test from 'node:test';

import type { ThreadExecution } from '../src/lib/workspace/runtime.js';
import { createWorkspaceService } from '../src/lib/workspace/service.js';
import type { WorkspaceService } from '../src/lib/workspace/types.js';
import { deferred, pool, workspace } from './helpers/workspace.js';

const createThread = async (service: WorkspaceService, projectId: string) => {
  const result = await service.threads.create(projectId, 'Thread');
  if (result.status !== 'created') throw new Error('Thread creation failed');
  return result.thread;
};

/**
 * A live Thread whose turns append two provider messages each and can be held
 * open, so running and queued states are deterministic without a database.
 */
const conversation = async () => {
  const harness = workspace();
  const published: string[] = [];
  const gates = new Map<
    string,
    { readonly started: () => void; readonly held: Promise<void> }
  >();
  const execute: ThreadExecution = async ({ thread, job, store }) => {
    const gate = gates.get(job.prompt);
    gate?.started();
    await gate?.held;
    const record = await store.find(thread.id);
    await store.saveMessages(thread.id, [
      ...(record?.messages ?? []),
      { role: 'user', content: job.prompt },
      { role: 'assistant', content: `${job.prompt} answer` },
    ]);
    return `${job.prompt} answer`;
  };
  const service = createWorkspaceService({
    ...harness.dependencies,
    publisher: {
      ...harness.publisher,
      event: (value) => {
        published.push(value.type);
        harness.publisher.event(value);
      },
    },
    pool: pool(),
    execute,
  });
  const project = await service.projects.create('Project');
  await harness.projectState(project.id, 'ready');
  const thread = await createThread(service, project.id);
  /** Holds the named turn open until its `release` is called. */
  const gate = (prompt: string) => {
    const started = deferred();
    const held = deferred();
    gates.set(prompt, { started: started.resolve, held: held.promise });
    return { started: started.promise, release: held.resolve };
  };
  const submit = async (prompt: string, target = thread.id) => {
    const accepted = await service.threads.prompt(target, prompt);
    if (accepted.status !== 'accepted')
      throw new Error(`Prompt was not accepted: ${accepted.status}`);
    return accepted.promptId;
  };
  /** Runs one complete turn of the conversation Thread and returns its ID. */
  const run = async (prompt: string) => {
    const turn = gate(prompt);
    const promptId = await submit(prompt);
    await turn.started;
    turn.release();
    await harness.threadState(thread.id, 'ready');
    return promptId;
  };
  const events = async (id = thread.id) =>
    (await service.threads.events(id, 0))!.events;
  const record = async (id = thread.id) => (await harness.threads.find(id))!;
  return {
    service,
    harness,
    thread,
    published,
    gate,
    submit,
    run,
    events,
    record,
  };
};

test('rewinds an earlier prompt onto the history that preceded it', async () => {
  const { service, harness, thread, published, gate, run, events, record } =
    await conversation();
  const first = await run('first');
  const second = await run('second');
  await run('third');
  const before = await events();
  assert.deepEqual(
    before.map(({ sequence }) => sequence),
    [1, 2, 3, 4, 5, 6],
  );
  published.length = 0;

  const edited = gate('edited');
  const result = await service.threads.rewind(thread.id, second, 'edited');

  if (result.status !== 'accepted')
    assert.fail(`Rewind was refused: ${result.status}`);
  // Subscribers must learn the surviving boundary before the replacement input.
  assert.deepEqual(published.slice(0, 2), [
    'history.truncated',
    'prompt.accepted',
  ]);
  const after = await events();
  // The edited turn and the later turn are gone; the earlier turn is intact.
  assert.deepEqual(
    after.map(({ sequence }) => sequence),
    [1, 2, 7, 8],
  );
  assert.deepEqual(after.slice(0, 2), before.slice(0, 2));
  const marker = after[2];
  assert.deepEqual(marker, {
    projectId: thread.projectId,
    threadId: thread.id,
    promptId: second,
    sequence: 7,
    type: 'history.truncated',
    event: { type: 'history.truncated', afterSequence: 2 },
    createdAt: '1970-01-01T00:00:00.000Z',
  });
  assert.equal(after[3]?.promptId, result.promptId);
  assert.deepEqual(after[3]?.event, {
    type: 'prompt.accepted',
    text: 'edited',
    source: { kind: 'user' },
  });
  // The replacement turn continues from the new tail, not from a reused number.
  assert.equal(after[3]?.sequence, marker.sequence + 1);

  await edited.started;
  edited.release();
  await harness.threadState(thread.id, 'ready');
  const settled = await events();
  assert.deepEqual(
    settled.map(({ type }) => type),
    [
      'prompt.accepted',
      'prompt.finished',
      'history.truncated',
      'prompt.accepted',
      'prompt.finished',
    ],
  );
  // Provider history is cut at the edited turn's checkpoint and regrown by it.
  const history = await record();
  assert.deepEqual(history.messages, [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'first answer' },
    { role: 'user', content: 'edited' },
    { role: 'assistant', content: 'edited answer' },
  ]);
  assert.deepEqual(history.checkpoints, {
    [first]: 0,
    [result.promptId]: 2,
  });
  assert.equal(settled.at(-1)?.sequence, 9);
  assert.equal(history.thread.lastSequence, 9);
  await service.dispose();
});

test('truncates to empty history when the first turn is edited', async () => {
  const { service, harness, thread, gate, run, events, record } =
    await conversation();
  const first = await run('first');
  await run('second');

  const edited = gate('edited');
  const result = await service.threads.rewind(thread.id, first, 'edited');
  if (result.status !== 'accepted')
    assert.fail(`Rewind was refused: ${result.status}`);

  const after = await events();
  assert.deepEqual(
    after.map(({ sequence, type }) => [sequence, type]),
    [
      [5, 'history.truncated'],
      [6, 'prompt.accepted'],
    ],
  );
  assert.deepEqual(after[0]?.event, {
    type: 'history.truncated',
    afterSequence: 0,
  });
  assert.deepEqual((await record()).messages, []);

  await edited.started;
  edited.release();
  await harness.threadState(thread.id, 'ready');
  assert.deepEqual((await record()).messages, [
    { role: 'user', content: 'edited' },
    { role: 'assistant', content: 'edited answer' },
  ]);
  await service.dispose();
});

test('refuses to rewind while the Thread is running', async () => {
  const { service, harness, thread, gate, submit, events, record } =
    await conversation();
  const running = gate('first');
  const promptId = await submit('first');
  await running.started;

  const result = await service.threads.rewind(thread.id, promptId, 'edited');
  assert.deepEqual(result, { status: 'busy' });
  assert.deepEqual(
    (await events()).map(({ type }) => type),
    ['prompt.accepted'],
  );
  assert.deepEqual((await record()).messages, []);

  running.release();
  await harness.threadState(thread.id, 'ready');
  assert.deepEqual(
    (await events()).map(({ type }) => type),
    ['prompt.accepted', 'prompt.finished'],
  );
  assert.deepEqual((await record()).messages, [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'first answer' },
  ]);
  await service.dispose();
});

test('refuses to rewind while inputs are queued and preserves their order', async () => {
  const { service, harness, thread, gate, submit, events, record } =
    await conversation();
  const first = gate('first');
  const second = gate('second');
  const third = gate('third');
  const promptId = await submit('first');
  await first.started;
  await submit('second');
  await submit('third');

  const result = await service.threads.rewind(thread.id, promptId, 'edited');
  assert.deepEqual(result, { status: 'busy' });

  first.release();
  await second.started;
  second.release();
  await third.started;
  third.release();
  await harness.threadState(thread.id, 'ready');
  const settled = await events();
  assert.equal(
    settled.filter(({ type }) => type === 'prompt.accepted').length,
    3,
  );
  assert.equal(
    settled.filter(({ type }) => type === 'prompt.finished').length,
    3,
  );
  assert.deepEqual((await record()).messages, [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'first answer' },
    { role: 'user', content: 'second' },
    { role: 'assistant', content: 'second answer' },
    { role: 'user', content: 'third' },
    { role: 'assistant', content: 'third answer' },
  ]);
  await service.dispose();
});

test('rejects a prompt that belongs to another Thread', async () => {
  const { service, harness, thread, gate, submit, run, events, record } =
    await conversation();
  const other = await createThread(service, thread.projectId);
  const own = await run('first');
  const foreign = gate('foreign');
  const promptId = await submit('foreign', other.id);
  await foreign.started;
  foreign.release();
  await harness.threadState(other.id, 'ready');
  const before = await events();
  const otherBefore = await events(other.id);

  const result = await service.threads.rewind(thread.id, promptId, 'edited');
  assert.deepEqual(result, { status: 'unknown_prompt' });
  assert.deepEqual(await events(), before);
  assert.deepEqual(await events(other.id), otherBefore);
  assert.deepEqual((await record()).messages, [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'first answer' },
  ]);
  assert.equal(before[0]?.promptId, own);
  await service.dispose();
});
