import assert from 'node:assert/strict';
import test from 'node:test';

import {
  type AnyServiceDefinition,
  AppHooksV1,
  type Call,
  type CatalogSnapshot,
  type ContractTool,
  type Disposable,
  DoricCatalogV1,
  DoricDiagnosticsV1,
  defineEvent,
  defineHook,
  defineHooks,
  defineSettings,
  defineStorageType,
  isContractError,
  type RegisteredSkill,
  type RegisteredTool,
  type Services,
  StorageBackendV1,
} from 'bundle/contracts';
import { createHopCall } from 'bundle/runtime';
import { z } from 'zod';

import { createEvents } from '../src/host/events/facade.js';
import { createSettings } from '../src/host/settings/facade.js';
import { createSkills } from '../src/host/skills.js';
import { createStorage } from '../src/host/storage/facade.js';
import { createTools } from '../src/host/tools.js';
import { createHooks } from '../src/shared/hooks.js';
import { createCoreState } from '../src/shared/state.js';

type Method = (input: unknown, call: Call, services: Services) => unknown;

/** Runs one method of a core service definition with an explicit call. */
const method = (definition: AnyServiceDefinition, name: string): Method => {
  const found = definition.methods[name];

  assert.ok(found, `${definition.id} has no method ${name}`);

  return found.execute as Method;
};

/**
 * A call of `bundleId` pinned to `generation` (0 = kernel), as the runtime
 * builds it for a hop without a parent call.
 */
const callOf = (bundleId: string, generation: number): Call =>
  createHopCall({
    caller: { bundleId, version: '1.0.0', generation: generation || 1 },
    generationSignal: new AbortController().signal,
    generation,
  });

interface World {
  /** The generation the kernel catalog reports as active. */
  active: number;
  /** How many times a core service read `doric.catalog/v1`. */
  catalogReads: number;
  readonly reports: unknown[];
  readonly services: Services;
}

/**
 * Services as the kernel core sees them: the platform catalog (whose
 * `generation` is the active one), diagnostics, a storage backend that keeps
 * documents in memory, and the core services under test, wired to each other
 * through `use` with the caller's call passed on.
 */
const world = (
  bundles: readonly { id: string; provides: readonly string[] }[],
  core: readonly AnyServiceDefinition[],
): World => {
  const documents = new Map<string, { revision: number; value: unknown }>();
  const state: World = {
    active: 1,
    catalogReads: 0,
    reports: [],
    services: undefined as unknown as Services,
  };
  const platform: Record<
    string,
    Record<string, (...args: never[]) => unknown>
  > = {
    [DoricCatalogV1.id]: {
      get: (): CatalogSnapshot => {
        state.catalogReads += 1;

        return {
          generation: state.active,
          composition: {} as CatalogSnapshot['composition'],
          bundles: bundles.map((bundle) => ({
            id: bundle.id,
            manifest: { provides: bundle.provides },
          })) as unknown as CatalogSnapshot['bundles'],
          order: bundles.map((bundle) => bundle.id),
          contracts: [],
        };
      },
    },
    [DoricDiagnosticsV1.id]: {
      report: (entry: never) => {
        state.reports.push(entry);
      },
    },
    [StorageBackendV1.id]: {
      declareType: async () => undefined,
      capabilities: async () => ({
        maxBatchOperations: 100,
        maxEventsPerAppend: 100,
        maxValueBytes: 1_000_000,
      }),
      get: async (key: { type: string; id: string }) => {
        const stored = documents.get(`${key.type}/${key.id}`);

        return stored === undefined ? undefined : { ...key, ...stored };
      },
      commit: async (batch: {
        put?: { type: string; id: string; value: unknown }[];
      }) => {
        for (const put of batch.put ?? []) {
          const key = `${put.type}/${put.id}`;

          documents.set(key, {
            revision: (documents.get(key)?.revision ?? 0) + 1,
            value: put.value,
          });
        }
      },
    },
  };
  const services: Services = {
    provide: () => ({ dispose: () => undefined }),
    whenAvailable: () => ({ dispose: () => undefined }),
    use: ((contract: { id: string }) => {
      const fixed = platform[contract.id];

      if (fixed !== undefined) {
        return fixed;
      }

      const definition = core.find((item) => item.id === contract.id);

      assert.ok(definition, `no provider of ${contract.id}`);

      return new Proxy(
        {},
        {
          get:
            (_target, name: string) =>
            (...args: unknown[]) => {
              // The core calls its own services as `core`, keeping the
              // parent call's generation, scope and signal.
              const call = createHopCall({
                caller: { bundleId: 'core', version: '1.0.0', generation: 1 },
                arg: args.at(-1) as Call,
                generationSignal: new AbortController().signal,
              });
              const rest = args.slice(0, -1);

              return method(definition, name)(
                rest.length === 1 ? rest[0] : rest,
                call,
                services,
              );
            },
        },
      );
    }) as Services['use'],
  };

  (state as { services: Services }).services = services;

  return state;
};

const tool = (name: string): ContractTool =>
  ({
    name,
    description: `The ${name} tool.`,
    execute: async () => name,
  }) as unknown as ContractTool;

const errorCode = (run: () => unknown): string | undefined => {
  try {
    run();
  } catch (error) {
    return isContractError(error) ? error.code : String(error);
  }

  return undefined;
};

const toolNames = (list: readonly RegisteredTool[]) =>
  list.map((entry) => `${entry.bundleId}:${entry.tool.name}`);

test('two generations register the same tool names and each view lists the kernel tools plus its own', () => {
  const tools = createTools();
  const w = world([], [tools]);
  const { services } = w;
  const register = method(tools, 'register');
  const list = method(tools, 'list');
  const options = { alwaysAvailable: false };

  register([tool('kernel_tool'), options], callOf('host', 0), services);
  const first = register(
    [tool('read'), options],
    callOf('files', 1),
    services,
  ) as Disposable;
  register([tool('read'), options], callOf('files', 2), services);

  assert.deepEqual(
    toolNames(list(undefined, callOf('x', 1), services) as RegisteredTool[]),
    ['host:kernel_tool', 'files:read'],
  );
  assert.deepEqual(
    toolNames(list(undefined, callOf('x', 2), services) as RegisteredTool[]),
    ['host:kernel_tool', 'files:read'],
  );
  assert.notEqual(
    (list(undefined, callOf('x', 1), services) as RegisteredTool[])[1]?.tool,
    (list(undefined, callOf('x', 2), services) as RegisteredTool[])[1]?.tool,
  );

  // Inside one generation and against the kernel partition, names stay unique.
  assert.equal(
    errorCode(() =>
      register([tool('read'), options], callOf('git', 2), services),
    ),
    'duplicate_tool',
  );
  assert.equal(
    errorCode(() =>
      register([tool('kernel_tool'), options], callOf('git', 2), services),
    ),
    'duplicate_tool',
  );
  assert.equal(
    errorCode(() =>
      register([tool('read'), options], callOf('host', 0), services),
    ),
    'duplicate_tool',
  );

  // A kernel call lists the active generation's tools.
  w.active = 1;
  const activeOne = list(
    undefined,
    callOf('host', 0),
    services,
  ) as RegisteredTool[];
  first.dispose();
  w.active = 2;
  const activeTwo = list(
    undefined,
    callOf('host', 0),
    services,
  ) as RegisteredTool[];

  assert.deepEqual(toolNames(activeOne), ['host:kernel_tool', 'files:read']);
  assert.deepEqual(toolNames(activeTwo), ['host:kernel_tool', 'files:read']);
  assert.notEqual(activeOne[1]?.tool, activeTwo[1]?.tool);
  assert.deepEqual(
    toolNames(list(undefined, callOf('x', 1), services) as RegisteredTool[]),
    ['host:kernel_tool'],
  );
});

test('in one process every registration is in the kernel partition and behaves as before', () => {
  const tools = createTools();
  const w = world([], [tools]);
  const register = method(tools, 'register');
  const options = { alwaysAvailable: true };

  register([tool('read'), options], callOf('files', 0), w.services);
  register([tool('status'), options], callOf('git', 0), w.services);

  assert.equal(
    errorCode(() =>
      register([tool('read'), options], callOf('git', 0), w.services),
    ),
    'duplicate_tool',
  );
  assert.deepEqual(
    toolNames(
      method(tools, 'list')(
        undefined,
        callOf('host', 0),
        w.services,
      ) as RegisteredTool[],
    ),
    ['files:read', 'git:status'],
  );
  assert.equal(w.catalogReads, 0);
});

test('skills resolve allowed tools and unique names inside their own generation', async () => {
  const tools = createTools();
  const skills = createSkills();
  const w = world([], [tools, skills]);
  const registerTool = method(tools, 'register');
  const registerSkill = method(skills, 'register');
  const skill = (name: string, allowedTools: string[]) => ({
    name,
    description: 'A skill.',
    body: 'Body.',
    allowedTools,
    indexText: name,
  });

  registerTool(
    [tool('read'), { alwaysAvailable: false }],
    callOf('files', 1),
    w.services,
  );
  registerSkill(
    [skill('reader', ['read']), undefined],
    callOf('files', 1),
    w.services,
  );

  // Generation 2 of the same bundle has not registered `read` yet.
  assert.equal(
    errorCode(() =>
      registerSkill(
        [skill('reader', ['read']), undefined],
        callOf('files', 2),
        w.services,
      ),
    ),
    'unavailable_tool',
  );

  registerTool(
    [tool('read'), { alwaysAvailable: false }],
    callOf('files', 2),
    w.services,
  );
  registerSkill(
    [skill('reader', ['read']), undefined],
    callOf('files', 2),
    w.services,
  );

  assert.equal(
    errorCode(() =>
      registerSkill(
        [skill('reader', []), undefined],
        callOf('git', 2),
        w.services,
      ),
    ),
    'duplicate_skill',
  );

  const listed = (await method(skills, 'list')(
    undefined,
    callOf('host', 2),
    w.services,
  )) as RegisteredSkill[];

  assert.deepEqual(
    listed.map((entry) => `${entry.bundleId}:${entry.skill.name}`),
    ['files:reader'],
  );
});

const OwnerHooksV1 = defineHooks('owner.hooks/v1', {
  onNoticeHook: defineHook({
    kind: 'observe',
    input: z.object({ text: z.string() }).strict(),
  }),
});

test('hooks run the kernel handlers plus the handlers of the executing generation only', async () => {
  const hooks = createHooks({ deadlineMs: 0 });
  const w = world(
    [
      { id: 'kernel', provides: [] },
      { id: 'owner', provides: ['owner.hooks/v1@1.0.0'] },
      { id: 'listener', provides: [] },
    ],
    [hooks],
  );
  const define = method(hooks, 'define');
  const register = method(hooks, 'register');
  const execute = method(hooks, 'execute');
  const heard: string[] = [];
  const handler = (label: string) => (input: { text: string }) => {
    heard.push(`${label}:${input.text}`);
  };

  const definedOne = define(
    OwnerHooksV1,
    callOf('owner', 1),
    w.services,
  ) as Disposable;
  define(OwnerHooksV1, callOf('owner', 2), w.services);
  register(
    [OwnerHooksV1, 'onNoticeHook', handler('kernel')],
    callOf('kernel', 0),
    w.services,
  );
  register(
    [OwnerHooksV1, 'onNoticeHook', handler('one')],
    callOf('listener', 1),
    w.services,
  );
  register(
    [OwnerHooksV1, 'onNoticeHook', handler('two')],
    callOf('listener', 2),
    w.services,
  );

  await execute(
    [OwnerHooksV1, 'onNoticeHook', { text: 'a' }],
    callOf('owner', 1),
    w.services,
  );
  await execute(
    [OwnerHooksV1, 'onNoticeHook', { text: 'b' }],
    callOf('owner', 2),
    w.services,
  );
  w.active = 2;
  await execute(
    [OwnerHooksV1, 'onNoticeHook', { text: 'c' }],
    callOf('doric', 0),
    w.services,
  );

  assert.deepEqual(heard, [
    'kernel:a',
    'one:a',
    'kernel:b',
    'two:b',
    'kernel:c',
    'two:c',
  ]);

  // Disposing generation 1's definition leaves generation 2's defined.
  const ran: string[] = [];

  method(hooks, 'whenDefined')(
    [
      OwnerHooksV1,
      () => {
        ran.push('defined');

        return () => {
          ran.push('undefined');
        };
      },
    ],
    callOf('listener', 2),
    w.services,
  );
  definedOne.dispose();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(ran, ['defined']);
  assert.equal(
    errorCode(() => define(OwnerHooksV1, callOf('other', 2), w.services)),
    'not_owner',
  );
});

test('a platform hooks contract is one shared definition seen through each view', async () => {
  const hooks = createHooks({ deadlineMs: 0 });
  const w = world([{ id: 'files', provides: [] }], [hooks]);
  const heard: string[] = [];

  method(hooks, 'define')(AppHooksV1, callOf('doric', 0), w.services);
  assert.equal(
    errorCode(() =>
      method(hooks, 'define')(AppHooksV1, callOf('files', 2), w.services),
    ),
    'not_owner',
  );

  for (const generation of [1, 2]) {
    method(hooks, 'register')(
      [
        AppHooksV1,
        'onHostReadyHook',
        () => {
          heard.push(`files@${generation}`);
        },
      ],
      callOf('files', generation),
      w.services,
    );
  }

  await method(hooks, 'execute')(
    [AppHooksV1, 'onHostReadyHook', {}],
    callOf('doric', 2),
    w.services,
  );

  assert.deepEqual(heard, ['files@2']);
});

test('storage types, settings and events are keyed by id and generation', async () => {
  const state = createCoreState({ now: () => 0 });
  const storage = createStorage(state);
  const settings = createSettings(state);
  const events = createEvents(state);
  const w = world(
    [
      {
        id: 'notes',
        provides: [
          'notes.item/v1@1.0.0',
          'notes.settings/v1@1.0.0',
          'notes.created/v1@1.0.0',
        ],
      },
      {
        id: 'core',
        provides: [
          'core.settings/v1@1.0.0',
          'core.settings-generation/v1@1.0.0',
        ],
      },
    ],
    [storage, settings, events],
  );
  const v1 = defineStorageType({
    type: 'notes.item/v1',
    schema: z.object({ title: z.string() }).strict(),
    indexes: [],
  });
  const v2 = defineStorageType({
    type: 'notes.item/v1',
    schema: z.object({ title: z.string(), pinned: z.boolean() }).strict(),
    indexes: [],
  });
  const defineType = method(storage, 'defineType');

  // The core's own documents, defined by the kernel.
  const { settingsType, settingsGenerationType } = await import(
    '../src/contracts/storage.js'
  );

  defineType(settingsType, callOf('core', 0), w.services);
  defineType(settingsGenerationType, callOf('core', 0), w.services);

  const typeOne = defineType(v1, callOf('notes', 1), w.services) as Disposable;
  defineType(v2, callOf('notes', 2), w.services);
  assert.equal(
    errorCode(() =>
      defineType(
        defineStorageType({
          type: 'notes.item/v1',
          schema: z.object({}).strict(),
          indexes: [],
        }),
        callOf('notes', 2),
        w.services,
      ),
    ),
    'registration_conflict',
  );
  typeOne.dispose();

  await method(storage, 'get')(
    { type: 'notes.item/v1', id: 'a' },
    callOf('notes', 2),
    w.services,
  );
  await assert.rejects(
    async () =>
      await method(storage, 'get')(
        { type: 'notes.item/v1', id: 'a' },
        callOf('notes', 1),
        w.services,
      ),
    (error) => isContractError(error) && error.code === 'unknown_type',
  );

  const space = defineSettings({
    id: 'notes.settings/v1',
    schema: z.object({ size: z.number() }).strict(),
  });
  const register = method(settings, 'register');
  const spaceOne = register(
    space,
    callOf('notes', 1),
    w.services,
  ) as Disposable;
  register(space, callOf('notes', 2), w.services);
  assert.equal(
    errorCode(() => register(space, callOf('notes', 2), w.services)),
    'registration_conflict',
  );

  const heard: string[] = [];

  for (const generation of [1, 2]) {
    method(settings, 'subscribe')(
      [
        space,
        (entry: { value: unknown }) =>
          heard.push(`${generation}:${JSON.stringify(entry.value)}`),
      ],
      callOf('notes', generation),
      w.services,
    );
  }

  await method(settings, 'set')(
    [space, { size: 3 }, undefined],
    callOf('notes', 2),
    w.services,
  );
  assert.deepEqual(heard, ['1:{"size":3}', '2:{"size":3}']);

  spaceOne.dispose();
  assert.deepEqual(
    await method(settings, 'get')(space, callOf('notes', 2), w.services),
    { size: 3 },
  );
  await assert.rejects(
    async () =>
      await method(settings, 'get')(space, callOf('notes', 1), w.services),
    (error) => isContractError(error) && error.code === 'unknown_settings',
  );

  const created = defineEvent({
    type: 'notes.created/v1',
    payload: z.object({ id: z.string() }).strict(),
  });
  const registerEvent = method(events, 'register');
  const eventOne = registerEvent(
    created,
    callOf('notes', 1),
    w.services,
  ) as Disposable;
  registerEvent(created, callOf('notes', 2), w.services);
  assert.equal(
    errorCode(() => registerEvent(created, callOf('notes', 0), w.services)),
    'registration_conflict',
  );
  eventOne.dispose();
  assert.equal(
    errorCode(() => registerEvent(created, callOf('notes', 2), w.services)),
    'registration_conflict',
  );
  assert.ok(registerEvent(created, callOf('notes', 1), w.services));
});
