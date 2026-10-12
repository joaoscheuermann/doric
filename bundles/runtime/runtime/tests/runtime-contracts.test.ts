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
  createdKey,
  ExecutorV1,
  executorMethods,
  historyType,
  isValidName,
  legacyEventTypes,
  migrationType,
  nameFromPrompt,
  type Project,
  projectType,
  promptFinishedEvent,
  qualifiedType,
  RuntimeHooksV1,
  RuntimeLeaseV1,
  type RuntimeNotice,
  RuntimeTerminalsV1,
  RuntimeThreadsV1,
  RuntimeUsageV1,
  RuntimeV1,
  RuntimeWorkspaceV1,
  runtimeLeaseMethods,
  runtimeMethods,
  runtimeTerminalsMethods,
  runtimeThreadsMethods,
  runtimeWorkspaceMethods,
  SandboxV1,
  sandboxMethods,
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
  'runtime.terminals/v1': runtimeTerminalsMethods,
  'host-config/v1': configurationMethods,
};

/** The stage-9 remote watches (R-STREAM): a stream listener, then a Disposable. */
const streams: Record<string, readonly string[]> = {
  'runtime/v1': ['watchProject'],
  'runtime.threads/v1': ['watchThread'],
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
    // 1.1.0: the generation handover members (57-WP-H); 1.2.0: watchProject.
    `${RuntimeV1.id}@1.2.0`,
    // 1.1.0: watchThread (stage 9 R-STREAM); 1.2.0: the terminal result
    // delivery (stage 10 R-5.3).
    `${RuntimeThreadsV1.id}@1.2.0`,
    // 1.1.0: withThread (stage 10 R-5.2).
    `${RuntimeWorkspaceV1.id}@1.1.0`,
    // 1.1.0: withLease (stage 10 R-5.1).
    `${RuntimeLeaseV1.id}@1.1.0`,
    // 1.1.0: watchProject (stage 9 R-STREAM).
    `${RuntimeTerminalsV1.id}@1.1.0`,
    // 1.1.0: onThreadsClosingHook (stage 10 R-5.4).
    `${RuntimeHooksV1.id}@1.1.0`,
    // Stage 10 R-5.5: the unfilled usage projection.
    `${RuntimeUsageV1.id}@1.0.0`,
    `${promptFinishedEvent.type}@1.0.0`,
    // terminal/v1 left with the stage-10 host switch: the `terminal` bundle
    // provides it, and runtime.terminals/v1 delegates to it.
    // The storage types the host part defines are provided contracts too.
    // 1.1.0: the internal `owner` field (57-WP-H).
    `${projectType.type}@1.1.0`,
    `${threadType.type}@1.0.0`,
    `${historyType.type}@1.0.0`,
    `${migrationType.type}@1.0.0`,
  ]);
  assert.deepEqual(manifest.requires, [
    'storage/v1@^1.0.0',
    'events/v1@^1.0.0',
    'hooks/v1@^1.0.0',
    'log/v1@^1.0.0',
    'secrets/v1@^1.0.0',
    'models/v1@^1.0.0',
    `${ConfigurationV1.id}@^1.0.0`,
    `${ExecutorV1.id}@^1.0.0`,
    `${SandboxV1.id}@^1.0.0`,
  ]);
  assert.ok(isHooksContract(RuntimeHooksV1));
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
