import assert from 'node:assert/strict';
import test from 'node:test';

import { z } from 'zod';

import {
  basicContracts,
  bindRegistrant,
  type Call,
  ContractError,
  type ContractTool,
  type Disposable,
  defineEvent,
  defineHook,
  defineHooks,
  defineMethod,
  defineService,
  disposableSchema,
  EventsV1,
  eventsMethods,
  HooksV1,
  isContractError,
  ref,
  type Services,
  ToolsV1,
} from '../src/contracts/index.js';
import { platformContracts } from '../src/contracts/platform.js';
import { fixedPlan, type RemoteTool } from '../src/runtime/envelope/index.js';
import { createHopCall, dispatch } from '../src/runtime/index.js';
import { basicProvider } from './support/basic.js';
import {
  flush,
  platformProviders,
  processes,
  snapshot,
} from './support/envelope.js';
import {
  createMinimalHooks,
  createMinimalTools,
} from './support/minimal-core.js';

const describePlan = (contractId: string, method: string): string => {
  const plan = fixedPlan(contractId, method);

  if (plan === undefined) {
    return 'unknown';
  }

  if (plan.refused !== undefined) {
    return 'refused';
  }

  if (plan.oneway === true) {
    return 'oneway';
  }

  const kinds = [...(plan.input ?? []), ...(plan.output ?? [])]
    .filter((kind, index, all) => all.indexOf(kind) === index)
    .sort();
  const shape = plan.optimistic === true ? 'optimistic' : 'crosses';

  return kinds.length === 0 ? shape : `${shape} via ${kinds.join('+')}`;
};

void test('every basic and platform method has a stated way across the envelope', () => {
  const expected: Record<string, Record<string, string>> = {
    'hooks/v1': {
      define: 'optimistic via disposable+hooks',
      register: 'optimistic via callback+disposable+hooks',
      whenDefined: 'optimistic via callback+disposable+hooks',
      execute: 'crosses via hooks',
    },
    'log/v1': {
      debug: 'oneway',
      info: 'oneway',
      warn: 'oneway',
      error: 'oneway',
    },
    'tools/v1': {
      register: 'optimistic via disposable+tool',
      list: 'crosses via tool',
      catalog: 'crosses',
    },
    'skills/v1': { register: 'optimistic via disposable', list: 'crosses' },
    'settings/v1': {
      register: 'optimistic via definition+disposable',
      get: 'crosses via definition',
      entry: 'crosses via definition',
      set: 'crosses via definition',
      subscribe: 'optimistic via callback+definition+disposable',
    },
    'secrets/v1': {
      resolve: 'crosses',
      list: 'crosses',
      describe: 'crosses',
      create: 'crosses',
      update: 'crosses',
      delete: 'crosses',
      resolveByKind: 'crosses',
      redactions: 'crosses',
      registerReferences: 'refused',
      view: 'refused',
    },
    'secrets.backend/v1': {
      get: 'crosses',
      list: 'crosses',
      put: 'crosses',
      delete: 'crosses',
    },
    'storage/v1': {
      defineType: 'optimistic via definition+disposable',
      get: 'crosses',
      query: 'crosses',
      read: 'crosses',
      commit: 'crosses',
      health: 'crosses',
    },
    'storage.backend/v1': {
      declareType: 'crosses',
      get: 'crosses',
      query: 'crosses',
      read: 'crosses',
      commit: 'crosses',
      feed: 'crosses',
      putBlob: 'crosses',
      getBlob: 'crosses',
      capabilities: 'crosses',
      health: 'crosses',
      identity: 'crosses',
    },
    'events/v1': {
      register: 'optimistic via definition+disposable',
      append: 'crosses via definition',
    },
    'models/v1': {
      resolve: 'crosses via object',
      kinds: 'crosses',
      kind: 'crosses',
      catalog: 'crosses',
      prepare: 'crosses',
    },
    'models.provider/v1': {
      kind: 'crosses',
      advertised: 'crosses',
      catalog: 'crosses',
      create: 'crosses via callback+object',
    },
    'commands/v1': { register: 'refused', execute: 'crosses' },
    'ui/v1': { define: 'refused', create: 'refused', dispose: 'refused' },
    'navigation/v1': {
      register: 'refused',
      navigate: 'crosses',
      back: 'crosses',
      current: 'crosses',
      chain: 'refused',
      subscribe: 'refused',
    },
    'regions/v1': {
      add: 'optimistic via disposable',
      items: 'refused',
      subscribe: 'refused',
    },
    'windows/v1': { open: 'crosses' },
    'menus/v1': {
      addItem: 'crosses',
      addKeybinding: 'crosses',
      setContext: 'crosses',
    },
    'doric.catalog/v1': {
      get: 'crosses',
      distribution: 'crosses',
      artifact: 'crosses',
      watch: 'optimistic via callback+disposable',
      disable: 'crosses',
      resetComposition: 'crosses',
    },
    'doric.diagnostics/v1': { get: 'crosses', report: 'oneway' },
    'doric.bundle/v1': { describe: 'crosses' },
    'doric.log/v1': { write: 'oneway' },
    'doric.windows/v1': {
      open: 'crosses',
      focusOrOpen: 'crosses',
      lastPath: 'crosses',
      focus: 'crosses',
    },
    'doric.menus/v1': {
      setSkeleton: 'crosses',
      add: 'crosses',
      addKeybinding: 'crosses',
      setContext: 'crosses',
    },
    'doric.cache/v1': { directory: 'crosses' },
    'doric.generation/v1': {
      describe: 'crosses',
      hold: 'optimistic via disposable',
    },
    'doric.tokens/v1': { get: 'crosses' },
    'doric.notifications/v1': { show: 'crosses' },
    // Client-only (stage 9): elements and callbacks stay in the window.
    'doric.elements/v1': {
      define: 'refused',
      owner: 'crosses',
      attach: 'refused',
      release: 'refused',
    },
    'doric.connection/v1': { status: 'crosses', subscribe: 'refused' },
  };
  const actual = Object.fromEntries(
    Object.entries({
      ...Object.fromEntries(
        Object.entries(basicContracts).map(([id, spec]) => [id, spec.methods]),
      ),
      ...Object.fromEntries(
        Object.entries(platformContracts).map(([id, spec]) => [
          id,
          spec.methods,
        ]),
      ),
    }).map(([id, methods]) => [
      id,
      Object.fromEntries(
        Object.keys(methods).map((method) => [
          method,
          describePlan(id, method),
        ]),
      ),
    ]),
  );

  assert.deepEqual(actual, expected);
});

// Hooks across processes ----------------------------------------------------

const OwnerHooks = defineHooks('owner.hooks/v1', {
  onSeen: defineHook({ kind: 'observe', input: z.object({ n: z.number() }) }),
  onValue: defineHook({
    kind: 'transform',
    input: z.object({ n: z.number() }),
  }),
  onAsk: defineHook({ kind: 'decide', input: z.object({ n: z.number() }) }),
});

/** Kernel: platform providers + minimal hooks core; the owner is a kernel bundle. */
const hooksWorld = () => {
  const world = processes();

  platformProviders(
    world.kernel,
    snapshot(['owner', 'kernel-a', 'files', 'zeta'], {
      owner: ['owner.hooks/v1@1.0.0'],
    }),
  );
  world.kernel.principal('mincore').services.provide(createMinimalHooks());
  world.kernel.expose('hooks/v1');

  const kernelHooks = (bundleId: string) =>
    world.kernel.principal(bundleId).services.use(HooksV1);
  const childHooks = world.generation.principal('files').services.use(HooksV1);

  return { world, kernelHooks, childHooks };
};

void test('handlers run in catalog order across the kernel and the generation', async () => {
  const { world, kernelHooks, childHooks } = hooksWorld();
  const order: string[] = [];
  const handle = kernelHooks('owner').define(OwnerHooks);

  kernelHooks('zeta')
    .use(OwnerHooks)
    .onSeen(() => {
      order.push('zeta');
    });
  childHooks.use(OwnerHooks).onSeen(() => {
    order.push('files');
  });
  kernelHooks('kernel-a')
    .use(OwnerHooks)
    .onSeen(() => {
      order.push('kernel-a');
    });
  await world.generation.link.settle('files');

  await handle.onSeen.execute({ n: 1 });

  assert.deepEqual(order, ['kernel-a', 'files', 'zeta']);
});

void test('a failing generation handler reaches diagnostics only; transform and decide chains cross', async () => {
  const { world, kernelHooks, childHooks } = hooksWorld();
  const handle = kernelHooks('owner').define(OwnerHooks);
  const hooks = childHooks.use(OwnerHooks);

  hooks.onSeen(() => {
    throw new Error('handler broke');
  });
  kernelHooks('kernel-a')
    .use(OwnerHooks)
    .onValue(({ n }) => ({ n: n + 1 }));
  hooks.onValue(({ n }) => ({ n: n * 10 }));
  hooks.onAsk(({ n }) =>
    n > 1 ? { allow: false, reason: `too big: ${n}` } : { allow: true },
  );
  await world.generation.link.settle('files');

  assert.equal(await handle.onSeen.execute({ n: 1 }), undefined);
  assert.deepEqual(
    world.kernel.reports
      .filter((report) => report.kind === 'hook_handler_failed')
      .map(({ bundleId, message }) => ({ bundleId, message })),
    [{ bundleId: 'files', message: 'handler broke' }],
  );
  assert.deepEqual(await handle.onValue.execute({ n: 1 }), { n: 20 });
  assert.deepEqual(await handle.onAsk.execute({ n: 1 }), { allow: true });
  assert.deepEqual(await handle.onAsk.execute({ n: 2 }), {
    allow: false,
    reason: 'too big: 2',
  });
});

void test('whenAvailable registrations end when the contract is undefined, then the callback cleanup runs', async () => {
  const { world, childHooks } = hooksWorld();
  const events: string[] = [];
  const owner = world.kernel.principal('owner');
  const hooks = (method: string, ...args: unknown[]) =>
    dispatch(owner, { contractId: 'hooks/v1' }, method, args);

  childHooks.whenAvailable(OwnerHooks, (registrar) => {
    events.push('available');
    registrar.onSeen(() => {
      events.push('handled');
    });

    return () => {
      events.push('cleanup');
    };
  });
  await world.generation.link.settle('files');

  const first = hooks('define', OwnerHooks) as Disposable;

  await flush();
  await world.generation.link.settle('files');
  await hooks('execute', OwnerHooks, 'onSeen', { n: 1 });

  first.dispose();
  await flush();
  await hooks('execute', OwnerHooks, 'onSeen', { n: 2 });
  assert.deepEqual(events, ['available', 'handled', 'cleanup']);

  // Defined again: the callback runs again and registers once.
  hooks('define', OwnerHooks);
  await flush();
  await world.generation.link.settle('files');
  await hooks('execute', OwnerHooks, 'onSeen', { n: 3 });
  assert.deepEqual(events, [
    'available',
    'handled',
    'cleanup',
    'available',
    'handled',
  ]);
});

void test('a generation handler receives its own schema parse of the input', async () => {
  const world = processes();
  const FilesHooks = defineHooks('files.hooks/v1', {
    onPath: defineHook({
      kind: 'observe',
      input: z.object({
        path: z.string().trim(),
        mode: z.string().default('fast'),
      }),
    }),
  });

  platformProviders(
    world.kernel,
    snapshot(['files'], { files: ['files.hooks/v1@1.0.0'] }),
  );
  world.kernel.principal('mincore').services.provide(createMinimalHooks());
  world.kernel.expose('hooks/v1');

  const hooks = world.generation.principal('files').services.use(HooksV1);
  const received: unknown[] = [];
  const handle = hooks.define(FilesHooks);

  hooks.use(FilesHooks).onPath((input) => {
    received.push(input);
  });
  await world.generation.link.settle('files');
  await handle.onPath.execute({ path: '  a.txt  ' } as never);

  assert.deepEqual(received, [{ path: 'a.txt', mode: 'fast' }]);
});

// Tools -----------------------------------------------------------------------

const toolInput = z.object({ path: z.string().min(1), limit: z.number() });

const readTool = (calls: Call[]) => ({
  name: 'read',
  definition: {
    name: 'read',
    description: 'Reads a file.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    outputSchema: { type: 'object' },
    strict: true,
  },
  [bindRegistrant]: (_services: Services): ContractTool => ({
    name: 'read',
    description: 'Reads a file.',
    input: toolInput,
    output: z.object({ text: z.string() }),
    definition: {
      name: 'read',
      description: 'Reads a file.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
      },
      outputSchema: { type: 'object' },
      strict: true,
    },
    settings: [{ key: 'root', label: 'Root', kind: 'text', required: false }],
    execute: async (payload, call) => {
      calls.push(call);

      return { text: `read ${(payload as { path: string }).path}` };
    },
  }),
});

const toolsWorld = () => {
  const world = processes();

  world.kernel.principal('mincore').services.provide(createMinimalTools());
  world.kernel.expose('tools/v1');

  return world;
};

void test('a generation tool reaches the kernel with its definition and settings as registered', async () => {
  const world = toolsWorld();
  const calls: Call[] = [];
  const tool = readTool(calls);
  const local = tool[bindRegistrant]({} as Services);

  world.generation
    .principal('files')
    .services.use(ToolsV1)
    .register(tool as never, { alwaysAvailable: true });
  await world.generation.link.settle('files');

  const [entry] = world.kernel.principal('host').services.use(ToolsV1).list();
  const remote = entry?.tool as RemoteTool;

  assert.equal(entry?.bundleId, 'files');
  assert.equal(entry?.alwaysAvailable, true);
  assert.equal(
    JSON.stringify(remote.definition),
    JSON.stringify(local.definition),
  );
  assert.deepEqual(remote.settings, local.settings);
  assert.equal(remote.name, 'read');
  assert.equal(remote.description, 'Reads a file.');
});

void test('check validates with the tool schema in its process; execute gets the prompt call', async () => {
  const world = toolsWorld();
  const calls: Call[] = [];

  world.generation
    .principal('files')
    .services.use(ToolsV1)
    .register(readTool(calls) as never, { alwaysAvailable: false });
  await world.generation.link.settle('files');

  const remote = world.kernel.principal('host').services.use(ToolsV1).list()[0]
    ?.tool as RemoteTool;

  assert.deepEqual(await remote.check({ path: '', limit: 'x' }), {
    success: false,
    issues: toolInput
      .safeParse({ path: '', limit: 'x' })
      .error?.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
  });
  assert.deepEqual(await remote.check({ path: 'a', limit: 1, extra: true }), {
    success: true,
    data: { path: 'a', limit: 1 },
  });

  const prompt = createHopCall({
    caller: { bundleId: 'doric', version: '1.0.0', generation: 1 },
    useScope: { projectId: 'p1', threadId: 't1', promptId: 'r1' },
    generationSignal: new AbortController().signal,
    generation: 2,
  });

  assert.deepEqual(
    await remote.toTool(prompt).execute({ path: 'a', limit: 1 }),
    {
      text: 'read a',
    },
  );

  const seen = calls[0] as Call;

  assert.equal(seen.caller.bundleId, 'doric');
  assert.deepEqual(seen.scope, prompt.scope);
  assert.equal(seen.trace.traceparent, prompt.trace.traceparent);
});

void test('a refused registration is collected by settle with the in-process error', async () => {
  const world = toolsWorld();

  world.kernel
    .principal('kernel-a')
    .services.use(ToolsV1)
    .register(readTool([]) as never, { alwaysAvailable: false });

  const end = world.generation.link.activating('files');
  const registration = world.generation
    .principal('files')
    .services.use(ToolsV1)
    .register(readTool([]) as never, { alwaysAvailable: false });

  assert.equal(typeof registration.dispose, 'function');

  const error = await world.generation.link.settle('files').then(
    () => assert.fail('expected a refusal'),
    (refusal: unknown) => refusal,
  );

  end();

  // The same refusal raised in one process.
  const inProcess = createMinimalTools();
  const caller = (bundleId: string) =>
    createHopCall({
      caller: { bundleId, version: '1.0.0', generation: 1 },
      generationSignal: new AbortController().signal,
    });
  const bound = readTool([])[bindRegistrant]({} as Services);

  inProcess.methods.register.execute(
    [bound, { alwaysAvailable: false }],
    caller('kernel-a'),
    {} as Services,
  );

  const expected = (() => {
    try {
      inProcess.methods.register.execute(
        [bound, { alwaysAvailable: false }],
        caller('files'),
        {} as Services,
      );
    } catch (refusal) {
      return refusal as ContractError;
    }

    return undefined;
  })();

  assert.ok(error instanceof ContractError);
  assert.equal((error as ContractError).code, expected?.code);
  assert.equal((error as ContractError).message, expected?.message);
  assert.equal(
    world.kernel.principal('host').services.use(ToolsV1).list().length,
    1,
  );
  await world.generation.link.settle('files');
});

void test('a refusal outside activation is reported as registration_failed', async () => {
  const world = toolsWorld();

  world.kernel
    .principal('kernel-a')
    .services.use(ToolsV1)
    .register(readTool([]) as never, { alwaysAvailable: false });
  world.generation
    .principal('files')
    .services.use(ToolsV1)
    .register(readTool([]) as never, { alwaysAvailable: false });
  await world.generation.link.settle('files');

  assert.deepEqual(
    world.generation.reports.map(({ bundleId, kind }) => ({ bundleId, kind })),
    [{ bundleId: 'files', kind: 'registration_failed' }],
  );
});

void test('disposing a generation registration removes it in the kernel', async () => {
  const world = toolsWorld();
  const registration = world.generation
    .principal('files')
    .services.use(ToolsV1)
    .register(readTool([]) as never, { alwaysAvailable: false });
  const tools = world.kernel.principal('host').services.use(ToolsV1);

  await world.generation.link.settle('files');
  assert.equal(tools.list().length, 1);

  registration.dispose();
  await flush();
  assert.equal(tools.list().length, 0);
});

void test('the registrations of a lost generation are disposed in the kernel', async () => {
  const world = toolsWorld();

  world.generation
    .principal('files')
    .services.use(ToolsV1)
    .register(readTool([]) as never, { alwaysAvailable: false });
  await world.generation.link.settle('files');
  world.transports.sever();
  await flush();

  assert.equal(
    world.kernel.principal('host').services.use(ToolsV1).list().length,
    0,
  );
});

// Bundle-defined local values -------------------------------------------------

class Session {
  readonly id = 's1';
}

const watchSchema = z
  .custom<(value: number) => void>((value) => typeof value === 'function')
  .meta({ 'x-doric-local': 'callback' });
const sessionSchema = z
  .custom<Session>((value) => value instanceof Session)
  .meta({ 'x-doric-local': 'object' });

void test('bundle-defined callbacks, disposables and home-unwrapped objects cross by their marker', async () => {
  const world = processes();
  const disposed: string[] = [];
  const sessions: unknown[] = [];
  let listener: ((value: number) => void) | undefined;
  const session = new Session();
  const runtime = defineService('runtime.watch/v1', {
    watch: defineMethod({
      input: watchSchema,
      output: disposableSchema,
      execute: (callback): Disposable => {
        listener = callback;

        return { dispose: () => disposed.push('watch') };
      },
    }),
    open: defineMethod({
      input: z.tuple([]),
      output: sessionSchema,
      execute: () => session,
    }),
    use: defineMethod({
      input: sessionSchema,
      output: z.boolean(),
      execute: (value) => {
        sessions.push(value);

        return value === session;
      },
    }),
  });
  const WatchV1 = ref<typeof runtime>('runtime.watch/v1');

  world.kernel.principal('runtime').services.provide(runtime);
  world.kernel.expose('runtime.watch/v1');

  const stub = world.generation.principal('direct').services.use(WatchV1);
  const values: number[] = [];
  const registration = await stub.watch((value) => values.push(value));

  (listener as (value: number) => void)(7);
  await flush();
  assert.deepEqual(values, [7]);

  registration.dispose();
  await flush();
  assert.deepEqual(disposed, ['watch']);

  const remote = await stub.open();

  assert.throws(
    () => (remote as Session).id,
    (error: unknown) => isContractError(error) && error.code === 'local_only',
  );
  assert.equal(await stub.use(remote), true);
  assert.equal(sessions[0], session);
});

void test('event definitions cross as mirrors that validate by their JSON Schema', async () => {
  const world = processes();
  const registered: unknown[] = [];

  world.kernel.principal('mincore').services.provide(
    basicProvider('events/v1', eventsMethods, {
      register: (definition: never) => {
        registered.push(definition);

        return { dispose: () => undefined };
      },
    }),
  );
  world.kernel.expose('events/v1');

  const Saved = defineEvent({
    type: 'files.saved/v1',
    payload: z.object({ path: z.string() }),
  });

  world.generation.principal('files').services.use(EventsV1).register(Saved);
  await world.generation.link.settle('files');

  const mirror = registered[0] as typeof Saved;

  assert.equal(mirror.kind, 'event');
  assert.equal(mirror.type, 'files.saved/v1');
  assert.equal(mirror.payload.safeParse({ path: 'a' }).success, true);
  assert.equal(mirror.payload.safeParse({ path: 1 }).success, false);
  assert.ok(new ContractError('x', 'y') instanceof Error);
});
