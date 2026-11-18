import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { defineMethod, defineService, isHooksContract } from 'bundle/contracts';
import {
  manifestV1Schema,
  memberSchema,
  streamItemSchema,
} from 'bundle/runtime';
import { createTestServices } from 'bundle/testing';
import { ConfigurationV1, configurationMethods } from 'host-config/contracts';
import type { z } from 'zod';

import {
  attachmentType,
  createdKey,
  type ExecutorThread,
  ExecutorV1,
  executorMethods,
  executorThreadSchema,
  historyType,
  isValidName,
  legacyEventTypes,
  migrationType,
  nameFromPrompt,
  type Project,
  projectType,
  promptFinishedEvent,
  qualifiedType,
  RuntimeAttachmentsV1,
  RuntimeHooksV1,
  RuntimeLeaseV1,
  type RuntimeNotice,
  RuntimeRecordsV1,
  RuntimeTerminalsV1,
  RuntimeThreadsV1,
  RuntimeUsageV1,
  RuntimeV1,
  RuntimeWorkspaceV1,
  runtimeAttachmentsMethods,
  runtimeLeaseMethods,
  runtimeMethods,
  runtimeTerminalsMethods,
  runtimeThreadsMethods,
  runtimeWorkspaceMethods,
  SandboxV1,
  sandboxMethods,
  type Thread,
  threadSubtreeIds,
  threadType,
} from '../src/contracts/index.js';
import { readTranscript } from './support/capture-adapter.js';

const LOCAL = 'x-doric-local';

type Specs = Readonly<
  Record<string, { readonly input: z.ZodType; readonly output: z.ZodType }>
>;

/** Every `x-doric-local` value of one generated member schema. */
const markers = (schema: z.ZodType, io: 'input' | 'output'): unknown[] => {
  const found: unknown[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (typeof value === 'object' && value !== null)
      for (const [key, entry] of Object.entries(value)) {
        if (key === LOCAL) found.push(entry);
        walk(entry);
      }
  };

  walk(memberSchema(schema, io).schema);

  return found;
};

const serializable: Record<string, Specs> = {
  'runtime.threads/v1': runtimeThreadsMethods,
  'runtime.workspace/v1': runtimeWorkspaceMethods,
  'runtime.lease/v1': runtimeLeaseMethods,
  'runtime.attachments/v1': runtimeAttachmentsMethods,
  'runtime.terminals/v1': runtimeTerminalsMethods,
  'host-config/v1': configurationMethods,
};

/** The stage-9 remote watches (R-STREAM): a stream listener, then a Disposable. */
const streams: Record<string, readonly string[]> = {
  'runtime/v1': ['watchProject'],
  // 1.8.0: viewThread holds a view while its stream is open.
  'runtime.threads/v1': ['watchThread', 'viewThread'],
  'runtime.terminals/v1': ['watchProject'],
};

/** The stage-10 local-only members (R-5.1, R-5.2): a task in, a value out. */
const localOnly: Record<string, readonly string[]> = {
  'runtime.workspace/v1': ['withThread'],
  'runtime.lease/v1': ['withLease'],
};

void test('the transport-facing contracts carry no process-local member', () => {
  for (const [contract, methods] of Object.entries(serializable))
    for (const [name, spec] of Object.entries(methods))
      if (
        !streams[contract]?.includes(name) &&
        !localOnly[contract]?.includes(name)
      )
        for (const io of ['input', 'output'] as const)
          assert.deepEqual(
            markers(spec[io], io),
            [],
            `${contract}.${name}.${io}`,
          );

  // watch and drain take a kernel listener (a callback across the envelope).
  for (const [name, spec] of Object.entries(runtimeMethods))
    if (name !== 'watch' && name !== 'drain' && name !== 'watchProject')
      for (const io of ['input', 'output'] as const)
        assert.deepEqual(markers(spec[io], io), [], `runtime/v1.${name}.${io}`);
});

void test('the remote watches cross as streams: only a listener and a Disposable are local', () => {
  const specs: Record<string, Specs> = {
    'runtime/v1': runtimeMethods,
    'runtime.threads/v1': runtimeThreadsMethods,
    'runtime.terminals/v1': runtimeTerminalsMethods,
  };
  for (const [contract, names] of Object.entries(streams))
    for (const name of names) {
      const spec = specs[contract]?.[name];
      assert.ok(spec !== undefined, `${contract}.${name}`);
      assert.deepEqual(markers(spec.input, 'input'), ['callback']);
      assert.deepEqual(markers(spec.output, 'output'), ['disposable']);
      assert.ok(
        streamItemSchema(memberSchema(spec.input, 'input').schema) !==
          undefined,
        `${contract}.${name} is a stream`,
      );
    }
});

void test('withThread and withLease take a local task and answer a local outcome', () => {
  for (const spec of [
    runtimeWorkspaceMethods.withThread,
    runtimeLeaseMethods.withLease,
  ]) {
    assert.deepEqual(markers(spec.input, 'input'), ['callback']);
    assert.deepEqual(markers(spec.output, 'output'), ['object']);
  }
});

void test('local members name the codec that carries them', () => {
  assert.deepEqual(markers(runtimeMethods.watch.input, 'input'), ['callback']);
  assert.deepEqual(markers(runtimeMethods.watch.output, 'output'), [
    'disposable',
  ]);
  assert.deepEqual(markers(runtimeMethods.drain.input, 'input'), ['callback']);
  assert.deepEqual(markers(runtimeMethods.drain.output, 'output'), []);
  assert.deepEqual(markers(sandboxMethods.acquire.output, 'output'), [
    'object',
  ]);
  for (const name of ['describe', 'discard', 'machines', 'machine'] as const)
    for (const io of ['input', 'output'] as const)
      assert.deepEqual(
        markers(sandboxMethods[name][io], io),
        [],
        `sandbox/v1.${name}`,
      );
  assert.deepEqual(markers(executorMethods.run.input, 'input'), ['object']);
  assert.deepEqual(markers(executorMethods.checkpoint.input, 'input'), [
    'object',
  ]);
  assert.deepEqual(markers(executorMethods.rewind.input, 'input'), ['object']);
});

void test('the manifest provides and requires exactly the stage 5 contracts', async () => {
  const manifest = manifestV1Schema.parse(
    JSON.parse(await readFile('bundles/runtime/runtime/manifest.json', 'utf8')),
  );

  assert.deepEqual(manifest.provides, [
    // 1.3.0: Project activity summaries for the desktop dashboard.
    `${RuntimeV1.id}@1.3.0`,
    // 1.1.0: watchThread (stage 9 R-STREAM); 1.2.0: the terminal result
    // delivery (stage 10 R-5.3); 1.3.0: steering a running prompt; 1.4.0:
    // retry; 1.5.0: a bundle's instruction and restarting a failed child;
    // 1.6.0: spawn options (agent, model, effort); 1.7.0: a Thread's own
    // provider, model and effort, and setThreadExecution; 1.8.0: archive,
    // restore, pin and view.
    `${RuntimeThreadsV1.id}@1.8.0`,
    // 1.1.0: withThread (stage 10 R-5.2).
    // 1.2.0: location
    `${RuntimeWorkspaceV1.id}@1.2.0`,
    // 1.1.0: withLease (stage 10 R-5.1); 1.2.0: readFileBytes.
    `${RuntimeLeaseV1.id}@1.2.0`,
    // The images a Project holds, for prompts and tool results.
    `${RuntimeAttachmentsV1.id}@1.0.0`,
    // 1.1.0: watchProject (stage 9 R-STREAM).
    `${RuntimeTerminalsV1.id}@1.1.0`,
    // 1.1.0: onThreadsClosingHook (stage 10 R-5.4).
    // 1.2.0: onPromptStartedHook and onThreadCwdChangedHook.
    `${RuntimeHooksV1.id}@1.2.0`,
    // Stage 10 R-5.5: the unfilled usage projection.
    `${RuntimeUsageV1.id}@1.0.0`,
    // Bundle isolation phase 3: the window's records mirror, a client
    // contract the runtime's client part provides.
    `${RuntimeRecordsV1.id}@1.0.0`,
    `${promptFinishedEvent.type}@1.0.0`,
    // terminal/v1 left with the stage-10 host switch: the `terminal` bundle
    // provides it, and runtime.terminals/v1 delegates to it.
    // The storage types the host part defines are provided contracts too.
    // 1.1.0: the internal `owner` field (57-WP-H).
    `${projectType.type}@1.1.0`,
    // 1.1.0: a spawned Thread's agent, model and effort; 1.2.0: providerId;
    // 1.3.0: the archive fields.
    `${threadType.type}@1.3.0`,
    `${historyType.type}@1.0.0`,
    `${migrationType.type}@1.0.0`,
    `${attachmentType.type}@1.0.0`,
  ]);
  assert.deepEqual(manifest.requires, [
    // 1.1.0: putBlob and getBlob, which hold the attachments' bytes.
    'storage/v1@^1.1.0',
    'events/v1@^1.0.0',
    'hooks/v1@^1.0.0',
    // The core's hooks: an append another bundle made reaches the runtime.
    'core.event-hooks/v1@^1.0.0',
    'log/v1@^1.0.0',
    'secrets/v1@^1.0.0',
    'models/v1@^1.0.0',
    `${ConfigurationV1.id}@^1.0.0`,
    // 1.4.0: the executor resolves a Thread's own provider.
    `${ExecutorV1.id}@^1.4.0`,
    `${SandboxV1.id}@^1.0.0`,
  ]);
  assert.ok(isHooksContract(RuntimeHooksV1));
});

void test('runtime/contracts exports threadSubtreeIds, which names a Thread and its descendants without its siblings', () => {
  const thread = (id: string, parentThreadId?: string): Thread => ({
    id,
    projectId: 'project-a',
    ...(parentThreadId === undefined ? {} : { parentThreadId }),
    name: id,
    state: 'ready',
    lastSequence: 0,
    cwd: '/workspace/doric',
    createdAt: '',
    updatedAt: '',
  });
  const values = [
    thread('root'),
    thread('child', 'root'),
    thread('grandchild', 'child'),
    thread('sibling'),
  ];

  assert.deepEqual([...threadSubtreeIds(values, 'root')].sort(), [
    'child',
    'grandchild',
    'root',
  ]);
  assert.deepEqual([...threadSubtreeIds(values, 'absent')], ['absent']);
});

void test('a watch listener reaches the provider and its registration is released', async () => {
  const listeners = new Set<(notice: RuntimeNotice) => void>();
  const refuse = () => Promise.reject(new Error('not used'));
  const methods = Object.fromEntries(
    Object.entries(runtimeMethods).map(([name, spec]) => [
      name,
      defineMethod({ ...spec, execute: refuse } as never),
    ]),
  );
  const harness = createTestServices({
    bundle: { id: 'consumer' },
    provide: [
      defineService(RuntimeV1, {
        ...methods,
        watch: defineMethod({
          ...runtimeMethods.watch,
          execute: (listener) => {
            listeners.add(listener);

            return { dispose: () => listeners.delete(listener) };
          },
        }),
      } as never),
    ],
  });
  const seen: RuntimeNotice[] = [];
  const registration = harness.services
    .use(RuntimeV1)
    .watch((notice) => seen.push(notice), harness.call());

  for (const listener of listeners)
    listener({ kind: 'projectDeleted', projectId: 'p-1' });
  registration.dispose();

  assert.deepEqual(seen, [{ kind: 'projectDeleted', projectId: 'p-1' }]);
  assert.equal(listeners.size, 0);
  await harness.dispose();
});

void test('a stored Project record with keys outside the contract travels unchanged', async () => {
  const record = {
    id: 'p-1',
    name: 'Project',
    color: 'teal',
    state: 'ready',
    configRevision: 3,
    createdAt: '2026-10-09T00:00:00.000Z',
    updatedAt: '2026-10-09T00:00:01.000Z',
    startedAt: '2026-10-09T00:00:01.000Z',
    extra: { kept: true },
  } as Project;
  const refuse = () => Promise.reject(new Error('not used'));
  const methods = Object.fromEntries(
    Object.entries(runtimeMethods).map(([name, spec]) => [
      name,
      defineMethod({ ...spec, execute: refuse } as never),
    ]),
  );
  const harness = createTestServices({
    bundle: { id: 'consumer' },
    provide: [
      defineService(RuntimeV1, {
        ...methods,
        project: defineMethod({
          ...runtimeMethods.project,
          execute: async (id) => (id === record.id ? record : undefined),
        }),
      } as never),
    ],
  });
  const runtime = harness.services.use(RuntimeV1);

  assert.equal(
    JSON.stringify(await runtime.project('p-1', harness.call())),
    JSON.stringify(record),
  );
  assert.equal(await runtime.project('p-2', harness.call()), undefined);
  await harness.dispose();
});

void test('recorded prompt.finished events read as the qualified event', async () => {
  const { steps } = await readTranscript();
  const finished = steps.flatMap((step) => {
    if (!('value' in step.outcome) || step.method !== 'events') return [];

    return (
      step.outcome.value as {
        events: { type: string; event: { type: string } }[];
      }
    ).events.filter(({ type }) => type === 'prompt.finished');
  });

  assert.ok(finished.length > 0);

  for (const { type, event } of finished) {
    assert.equal(qualifiedType(type), 'runtime.prompt-finished/v1');
    // The durable body keeps its own `type`; the payload is loose.
    assert.equal(event.type, 'prompt.finished');
    assert.deepEqual(promptFinishedEvent.payload.parse(event), event);
  }

  assert.equal(qualifiedType('prompt.started'), undefined);
  assert.equal(qualifiedType('constructor'), undefined);
  assert.deepEqual(Object.keys(legacyEventTypes), ['prompt.finished']);
});

void test('createdKey orders documents by creation time, then id', () => {
  const rows = [
    ['2026-10-09T12:00:00.000Z', 'b'],
    ['2026-10-09T11:59:59.999Z', 'z'],
    ['2026-10-09T12:00:00.000Z', 'a'],
  ] as const;
  const byKey = rows
    .map(([at, id]) => createdKey(at, id))
    .sort()
    .map((key) => key.split('|')[1]);

  assert.deepEqual(byKey, ['z', 'a', 'b']);
});

void test('the storage types declare the documents and list indexes', () => {
  assert.deepEqual(
    [projectType, threadType, historyType, migrationType].map(
      ({ type, indexes }) => [type, indexes.map(({ name }) => name)],
    ),
    [
      ['runtime.project/v1', ['byCreated', 'byOpen']],
      ['runtime.thread/v1', ['byProject', 'byParent', 'byOpen']],
      ['runtime.history/v1', ['byThread']],
      ['runtime.migration/v1', []],
    ],
  );
  assert.equal(
    threadType.schema.safeParse({ id: 'not-a-thread' }).success,
    false,
  );
});

void test('names keep their current validation rules', () => {
  assert.equal(isValidName(''), false);
  assert.equal(isValidName('a\0b'), false);
  assert.equal(isValidName('x'.repeat(80)), true);
  assert.equal(isValidName('x'.repeat(81)), false);
  assert.equal(nameFromPrompt(`  ${'😀'.repeat(81)}  `), '😀'.repeat(80));
  assert.equal(nameFromPrompt('a\0b'), 'a�b');
});

/*
 * DORIC-73: executor/v1 1.3.0 types the Thread a run and a compaction receive
 * as an ExecutorThread — the agent with its instructions, the model and the
 * effort — and validates the instructions as a string.
 */

const executorThread: ExecutorThread = {
  id: 'thread-1',
  projectId: 'project-1',
  name: 'Reviewer',
  state: 'running',
  lastSequence: 0,
  cwd: '/workspace',
  createdAt: '2026-03-01T00:00:00.000Z',
  updatedAt: '2026-03-01T00:00:00.000Z',
  agent: {
    name: 'reviewer',
    source: 'workspace',
    instructions: 'Review the diff.',
  },
  model: 'thread-model',
  effort: 'low',
};

const job = { id: 'prompt-1', prompt: 'review', source: { kind: 'user' } };
const session = {
  history: { format: undefined, read: () => Promise.resolve(undefined) },
  record: () => Promise.resolve(),
  steers: () => Promise.resolve([]),
};
const policy = { tailMinMessages: 2, summaryMaxChars: 6000 };

/** The run and compaction inputs carrying `thread`. */
const executorInputs = (thread: unknown) =>
  [
    [
      'run',
      () => executorMethods.run.input.safeParse({ thread, job, session }),
    ],
    [
      'compact',
      () =>
        executorMethods.compact.input.safeParse({ thread, session, policy }),
    ],
  ] as const;

void test('RC1 a run and a compaction keep the agent instructions, the model, the effort and loose keys', () => {
  for (const [name, parse] of executorInputs({
    ...executorThread,
    extra: 'kept',
  })) {
    const parsed = parse();
    assert.equal(parsed.success, true, name);
    if (!parsed.success) continue;
    assert.deepEqual(
      parsed.data.thread,
      { ...executorThread, extra: 'kept' },
      name,
    );
  }
  assert.deepEqual(executorThreadSchema.parse(executorThread), executorThread);
});

void test('RC1 a run and a compaction refuse an agent without string instructions', () => {
  const withoutInstructions = { name: 'reviewer', source: 'workspace' };
  for (const agent of [
    withoutInstructions,
    { ...withoutInstructions, instructions: 42 },
  ]) {
    const thread = { ...executorThread, agent };
    for (const [name, parse] of executorInputs(thread))
      assert.equal(parse().success, false, `${name}: ${JSON.stringify(agent)}`);
    assert.equal(executorThreadSchema.safeParse(thread).success, false);
  }
});

void test('RC1 the executor Thread schema is no process-local member', () => {
  assert.deepEqual(markers(executorThreadSchema, 'input'), []);
  assert.deepEqual(markers(executorMethods.run.input, 'input'), ['object']);
  assert.deepEqual(markers(executorMethods.compact.input, 'input'), ['object']);
});

void test('runtime.threads/v1 1.7.0 declares setThreadExecution next to setThreadCwd with the configuration bounds', () => {
  const methods = Object.keys(runtimeThreadsMethods);
  assert.equal(
    methods.indexOf('setThreadExecution'),
    methods.indexOf('setThreadCwd') + 1,
  );
  const { input, output } = runtimeThreadsMethods.setThreadExecution;
  const base = { id: 't-1', providerId: 'p-1', model: 'm-1' };
  for (const accepted of [
    base,
    { ...base, effort: 'high' },
    { ...base, providerId: 'p'.repeat(128), model: 'm'.repeat(512) },
  ])
    assert.equal(
      input.safeParse(accepted).success,
      true,
      JSON.stringify(accepted).slice(0, 80),
    );
  for (const [what, refused] of [
    ['an unknown effort', { ...base, effort: 'extreme' }],
    ['a blank provider', { ...base, providerId: '  ' }],
    ['a blank model', { ...base, model: '' }],
    [
      'a provider over 128 characters',
      { ...base, providerId: 'p'.repeat(129) },
    ],
    ['a model over 512 characters', { ...base, model: 'm'.repeat(513) }],
    ['no model', { id: 't-1', providerId: 'p-1' }],
    ['an extra key', { ...base, name: 'Renamed' }],
  ] as const)
    assert.equal(input.safeParse(refused).success, false, what);

  const thread = {
    id: 't-1',
    projectId: 'p-1',
    name: 'Thread',
    state: 'ready',
    queuePaused: false,
    lastSequence: 0,
    cwd: '/workspace',
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-01T00:00:00.000Z',
    model: 'm-1',
    providerId: 'p-1',
  };
  for (const result of [
    { status: 'updated', thread },
    { status: 'missing' },
    { status: 'invalid', reason: 'provider' },
    { status: 'invalid', reason: 'model' },
    { status: 'invalid', reason: 'effort' },
    { status: 'unresolvable', message: 'Configured provider is unavailable.' },
  ])
    assert.equal(
      output.safeParse(result).success,
      true,
      JSON.stringify(result),
    );
  const updated = output.safeParse({ status: 'updated', thread });
  assert.equal(
    updated.success && 'thread' in updated.data
      ? updated.data.thread.providerId
      : undefined,
    'p-1',
  );
  assert.equal(
    output.safeParse({ status: 'invalid', reason: 'agent' }).success,
    false,
  );
});

void test('runtime.threads/v1 1.8.0 declares archiveThread, restoreThread, setThreadPinned and viewThread', () => {
  const thread = {
    id: '00000000-0000-4000-8000-000000000001',
    projectId: '00000000-0000-4000-8000-000000000002',
    name: 'Thread',
    state: 'ready',
    lastSequence: 0,
    cwd: '/workspace',
    createdAt: '2026-11-17T00:00:00.000Z',
    updatedAt: '2026-11-17T00:00:00.000Z',
    archivedAt: '2026-11-17T01:00:00.000Z',
    pinned: true,
  };
  const batch = '00000000-0000-4000-8000-000000000003';
  const { archiveThread, restoreThread, setThreadPinned, viewThread } =
    runtimeThreadsMethods;
  for (const answer of [
    { status: 'archived', batch, threads: [thread] },
    { status: 'missing' },
    { status: 'busy' },
    { status: 'already_archived' },
  ])
    assert.equal(
      archiveThread.output.safeParse(answer).success,
      true,
      answer.status,
    );
  for (const answer of [
    { status: 'restored', threads: [thread] },
    { status: 'missing' },
    { status: 'not_archived' },
  ])
    assert.equal(
      restoreThread.output.safeParse(answer).success,
      true,
      answer.status,
    );
  assert.equal(archiveThread.input.safeParse({ id: thread.id }).success, true);
  assert.equal(
    restoreThread.input.safeParse({ id: thread.id, batch }).success,
    true,
  );
  assert.equal(
    restoreThread.input.safeParse({ id: thread.id, batch: 'nope' }).success,
    false,
  );
  assert.equal(
    setThreadPinned.input.safeParse({ id: thread.id, pinned: true }).success,
    true,
  );
  assert.equal(setThreadPinned.output.safeParse(undefined).success, true);
  const pinned = setThreadPinned.output.safeParse(thread);
  assert.equal(pinned.success && pinned.data?.pinned, true);
  assert.deepEqual(markers(viewThread.input, 'input'), ['callback']);
  assert.deepEqual(markers(viewThread.output, 'output'), ['disposable']);
});
