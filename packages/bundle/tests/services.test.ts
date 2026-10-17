import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';

import { z } from 'zod';

import { definePlatformService } from '../src/contracts/define.js';
import {
  AppHooksV1,
  bindRegistrant,
  type Call,
  type Disposable,
  defineHook,
  defineHooks,
  defineMethod,
  defineService,
  HooksV1,
  isContractError,
  LogV1,
  ref,
  type Services,
} from '../src/contracts/index.js';
import {
  type CatalogSnapshot,
  DoricCatalogV1,
  platformContracts,
} from '../src/contracts/platform.js';
import {
  type ContractCatalogView,
  createPrincipal,
  emptyCatalogView,
  type PrincipalOptions,
  ServiceDirectory,
  type ServiceRuntime,
} from '../src/runtime/index.js';
import { createMinimalHooks } from './support/minimal-core.js';

const setup = (catalog: Partial<ContractCatalogView> = {}) => {
  const controller = new AbortController();
  const reports: { bundleId: string; kind: string }[] = [];
  const runtime: ServiceRuntime = {
    directory: new ServiceDirectory(),
    catalog: { ...emptyCatalogView, ...catalog },
    environment: 'host',
    generation: 3,
    generationSignal: controller.signal,
    report: (entry) => reports.push(entry),
  };
  const principal = (
    bundleId: string,
    options: Partial<PrincipalOptions> = {},
  ) =>
    createPrincipal(runtime, {
      bundleId,
      version: '1.0.0',
      provides: 'any',
      requires: 'any',
      ...options,
    });

  return { controller, reports, runtime, principal };
};

const codeOf = (expected: string) => (error: unknown) =>
  isContractError(error) && error.code === expected;

const echo = defineService('alpha.echo/v1', {
  say: defineMethod({
    input: z.string(),
    output: z.object({ text: z.string() }),
    execute: (text, call) => ({ text, caller: call.caller.bundleId }),
  }),
  inspect: defineMethod({
    input: z.tuple([]),
    output: z.custom<Call>(),
    execute: (_input, call) => call,
  }),
});

const EchoV1 = ref<typeof echo>('alpha.echo/v1');

void test('use outside requires throws undeclared_requirement, with the documented exemptions', () => {
  const { principal } = setup();
  const strict = principal('strict', {
    requires: new Set(['alpha.echo/v1']),
    provides: new Map(),
    ownContracts: new Set(['strict.api/v1']),
  });

  assert.throws(
    () => strict.services.use(ref('beta.api/v1')),
    codeOf('undeclared_requirement'),
  );
  assert.throws(
    () => strict.services.use(LogV1),
    codeOf('undeclared_requirement'),
  );

  strict.services.use(EchoV1);
  strict.services.use(ref('doric.catalog/v1'));
  strict.services.use(ref('strict.api/v1'));

  const core = principal('core', {
    requires: new Set(),
    provides: new Map(),
    isCore: true,
  });

  core.services.use(LogV1);
});

void test('use of a many contract throws many_contract_use', () => {
  const { principal } = setup({
    cardinality: (id) => (id === 'alpha.plugins/v1' ? 'many' : undefined),
  });
  const consumer = principal('consumer');

  assert.throws(
    () => consumer.services.use(ref('alpha.plugins/v1')),
    codeOf('many_contract_use'),
  );
  assert.throws(
    () => consumer.services.use(ref('models.provider/v1')),
    codeOf('many_contract_use'),
  );
});

void test('stubs bind late: unavailable before provide and after deactivation', async () => {
  const { principal } = setup();
  const consumer = principal('consumer');
  const stub = consumer.services.use(EchoV1);

  assert.throws(() => stub.say('early'), codeOf('unavailable'));

  const registration = principal('alpha').services.provide(echo);

  assert.deepEqual(await Promise.resolve(stub.say('hi')), {
    text: 'hi',
    caller: 'consumer',
  });

  registration.dispose();

  assert.throws(() => stub.say('late'), codeOf('unavailable'));
});

void test('provide followed by use in the same activate resolves synchronously', () => {
  const { principal } = setup();
  const alpha = principal('alpha');

  alpha.services.provide(echo);

  assert.equal(alpha.services.use(EchoV1).say('now').text, 'now');
});

void test('provide checks declaration, cardinality and conflicts', () => {
  const { principal } = setup();

  assert.throws(
    () =>
      principal('undeclared', { provides: new Map() }).services.provide(echo),
    codeOf('undeclared_provide'),
  );
  assert.throws(
    () =>
      principal('declared-many', {
        provides: new Map([
          ['alpha.echo/v1', { version: '1.0.0', cardinality: 'many' as const }],
        ]),
      }).services.provide(echo),
    codeOf('cardinality_mismatch'),
  );

  principal('first').services.provide(echo);

  assert.throws(
    () => principal('second').services.provide(echo),
    codeOf('provider_conflict'),
  );
});

void test('a basic provider must match the platform method specification', () => {
  const { principal } = setup();
  const wrongMethods = defineService('log/v1', {
    info: defineMethod({
      input: z.tuple([
        z.string(),
        z.record(z.string(), z.unknown()).optional(),
      ]),
      output: z.void(),
      execute: () => undefined,
    }),
  });
  const wrongSchema = defineService('log/v1', {
    ...Object.fromEntries(
      ['debug', 'info', 'warn', 'error'].map((level) => [
        level,
        defineMethod({
          input: z.tuple([z.number()]),
          output: z.void(),
          execute: () => undefined,
        }),
      ]),
    ),
  });

  assert.throws(
    () => principal('a').services.provide(wrongMethods),
    codeOf('contract_mismatch'),
  );
  assert.throws(
    () => principal('b').services.provide(wrongSchema),
    codeOf('contract_mismatch'),
  );
});

void test('a one contract the composition chose elsewhere is provided inertly', () => {
  const { principal, runtime } = setup({
    activeProvider: (id) => (id === 'hooks/v1' ? 'myhooks' : undefined),
  });
  const registration = principal('core').services.provide(createMinimalHooks());

  assert.equal(runtime.directory.active('hooks/v1'), undefined);

  registration.dispose();
  principal('myhooks').services.provide(createMinimalHooks());

  assert.equal(runtime.directory.active('hooks/v1')?.bundleId, 'myhooks');
});

void test('whenAvailable follows providers and disposes what the callback registered', async () => {
  const { principal } = setup();
  const active = new Set<string>();
  const registry = defineService('reg.items/v1', {
    add: defineMethod({
      input: z.string(),
      output: z.custom<Disposable>(),
      execute: (name) => {
        active.add(name);

        return { dispose: () => active.delete(name) };
      },
    }),
  });
  const RegistryV1 = ref<typeof registry>('reg.items/v1');

  principal('registry').services.provide(registry);

  const consumer = principal('consumer');
  const seen: string[] = [];
  let cleanups = 0;

  consumer.services.whenAvailable(EchoV1, (api, provider) => {
    seen.push(provider.bundleId);
    consumer.services.use(RegistryV1).add(`for-${provider.bundleId}`);
    assert.equal(api.say('x').text, 'x');

    return () => {
      cleanups += 1;
    };
  });

  assert.deepEqual(seen, []);

  const first = principal('alpha').services.provide(echo);

  assert.deepEqual(seen, ['alpha']);
  assert.deepEqual([...active], ['for-alpha']);

  first.dispose();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual([...active], []);
  assert.equal(cleanups, 1);

  principal('alpha2').services.provide(echo);

  assert.deepEqual(seen, ['alpha', 'alpha2']);
});

void test('whenAvailable on a many contract runs once per provider, including later ones', () => {
  const { principal } = setup({
    cardinality: (id) => (id === 'alpha.plugins/v1' ? 'many' : undefined),
  });
  const plugin = (name: string) =>
    defineService(
      'alpha.plugins/v1',
      {
        name: defineMethod({
          input: z.tuple([]),
          output: z.string(),
          execute: () => name,
        }),
      },
      { cardinality: 'many' },
    );
  const PluginsV1 = ref<ReturnType<typeof plugin>>('alpha.plugins/v1');

  principal('one').services.provide(plugin('one'));

  const names: string[] = [];

  principal('host').services.whenAvailable(PluginsV1, (api) => {
    names.push(api.name());
  });
  principal('two').services.provide(plugin('two'));

  assert.deepEqual(names, ['one', 'two']);
});

void test('a whenAvailable callback failure is reported, not thrown to the provider', () => {
  const { principal, reports } = setup();

  principal('fragile').services.whenAvailable(EchoV1, () => {
    throw new Error('callback broke');
  });
  principal('alpha').services.provide(echo);

  assert.deepEqual(
    reports.map(({ bundleId }) => bundleId),
    ['fragile'],
  );
});

void test('registrables are bound to the calling bundle before validation', () => {
  const { principal } = setup();
  let received: unknown;
  const registry = defineService('reg.bound/v1', {
    register: defineMethod({
      input: z.custom<{ services: Services }>(),
      output: z.custom<Disposable>(),
      execute: (bound) => {
        received = bound;

        return { dispose: () => undefined };
      },
    }),
  });

  principal('registry').services.provide(registry);

  const caller = principal('caller');

  caller.services.use(ref<typeof registry>('reg.bound/v1')).register({
    [bindRegistrant]: (services: Services) => ({ services }),
  } as never);

  assert.equal((received as { services: Services }).services, caller.services);
});

void test('outputs are validated and the original value is forwarded', async () => {
  const { principal } = setup();
  const original = { id: 't1', extra: 'kept' };
  const service = defineService('alpha.loose/v1', {
    get: defineMethod({
      input: z.tuple([]),
      output: z.object({ id: z.string() }),
      execute: async () => {
        await Promise.resolve();

        return original;
      },
    }),
    bad: defineMethod({
      input: z.tuple([]),
      output: z.object({ id: z.string() }),
      execute: () => ({ id: 1 }) as never,
    }),
  });

  principal('alpha').services.provide(service);

  const stub = principal('consumer').services.use(
    ref<typeof service>('alpha.loose/v1'),
  );

  assert.equal(await stub.get(), original);
  assert.throws(() => stub.bad(), codeOf('invalid_output'));
});

void test('invalid input throws synchronously and thrown values propagate unchanged', () => {
  const { principal } = setup();
  const failure = new TypeError('Thread is not a direct child.');
  const service = defineService('alpha.strict/v1', {
    run: defineMethod({
      input: z.object({ n: z.number() }).strict(),
      output: z.void(),
      execute: async () => {
        await Promise.resolve();
        throw failure;
      },
    }),
  });

  principal('alpha').services.provide(service);

  const stub = principal('consumer').services.use(
    ref<typeof service>('alpha.strict/v1'),
  );

  assert.throws(() => stub.run({ n: 'x' } as never), codeOf('invalid_input'));

  return assert.rejects(stub.run({ n: 1 }), (error) => error === failure);
});

void test('the caller of every hop is the bundle that makes it, with scope merged', () => {
  const { principal } = setup();

  principal('alpha').services.provide(echo);

  const relay = defineService('beta.relay/v1', {
    forward: defineMethod({
      input: z.tuple([]),
      output: z.custom<Call>(),
      execute: (_input, call, services) =>
        services.use(EchoV1, { threadId: 't2' }).inspect(call),
    }),
  });

  principal('beta').services.provide(relay);

  const platform = principal('doric');
  const parentCall = platform.services
    .use(ref<typeof echo>('alpha.echo/v1'), {
      projectId: 'p',
      threadId: 't1',
    })
    .inspect();
  const relayed = platform.services
    .use(ref<typeof relay>('beta.relay/v1'), { projectId: 'p', threadId: 't1' })
    .forward();

  assert.equal(parentCall.caller.bundleId, 'doric');
  assert.equal(relayed.caller.bundleId, 'beta');
  assert.deepEqual(relayed.scope, { projectId: 'p', threadId: 't2' });
  assert.equal(relayed.caller.generation, 3);
});

void test('call options carry a deadline that aborts call.signal', async () => {
  const { principal, controller } = setup();

  principal('alpha').services.provide(echo);

  const stub = principal('consumer').services.use(EchoV1);
  const timed = stub.inspect({ deadline: Date.now() + 20 });
  const plain = stub.inspect();

  assert.equal(timed.scope, undefined);
  await once(timed.signal, 'abort');
  assert.equal(timed.signal.aborted, true);
  assert.equal(plain.signal.aborted, false);

  controller.abort();
  assert.equal(plain.signal.aborted, true);
});

void test('a trailing object is call options only when the tuple item rejects it', () => {
  const { principal } = setup();
  const received: unknown[] = [];
  const log = defineService('log/v1', {
    ...Object.fromEntries(
      ['debug', 'info', 'warn', 'error'].map((level) => [
        level,
        defineMethod({
          input: z.tuple([
            z.string(),
            z.record(z.string(), z.unknown()).optional(),
          ]),
          output: z.void(),
          execute: ([, fields], call) => {
            received.push({ fields, caller: call.caller.bundleId });
          },
        }),
      ]),
    ),
  });

  principal('core').services.provide(log);

  const consumer = principal('consumer');
  const stub = consumer.services.use(LogV1);
  const parent = consumer.services.use(EchoV1);

  principal('alpha').services.provide(echo);

  const call = parent.inspect();

  stub.info('fields', { deadline: 5 });
  stub.info('call', call as never);

  assert.deepEqual(received, [
    { fields: { deadline: 5 }, caller: 'consumer' },
    { fields: undefined, caller: 'consumer' },
  ]);
});

void test('a closed principal refuses stub calls', () => {
  const { principal } = setup();

  principal('alpha').services.provide(echo);

  const consumer = principal('consumer');
  const stub = consumer.services.use(EchoV1);

  consumer.close();

  assert.throws(() => stub.say('x'), codeOf('unavailable'));
});

void test('hooks/v1 consumers get one handle per owner and register through the provider', async () => {
  const { principal } = setup();
  const OwnerHooksV1 = defineHooks('owner.hooks/v1', {
    onThingHook: defineHook({
      kind: 'transform',
      input: z.object({ value: z.number() }).strict(),
    }),
  });

  const snapshot: CatalogSnapshot = {
    generation: 3,
    composition: { core: 'core', enabled: ['core', 'owner'], providers: {} },
    bundles: [
      {
        id: 'owner',
        version: '1.0.0',
        state: 'active',
        manifest: {
          manifestVersion: 1,
          id: 'owner',
          version: '1.0.0',
          engines: { doric: '^1.0.0' },
          provides: ['owner.hooks/v1@1.0.0'],
          requires: ['hooks/v1@^1.0.0'],
        },
        reasons: [],
      },
    ],
    order: ['core', 'owner', 'consumer'],
    contracts: [],
  };

  principal('doric').services.provide(
    definePlatformService(DoricCatalogV1, {
      get: defineMethod({
        ...platformContracts['doric.catalog/v1'].methods.get,
        execute: () => snapshot,
      }),
    }),
  );
  principal('core').services.provide(createMinimalHooks());

  const owner = principal('owner');
  const consumer = principal('consumer');
  const handle = owner.services.use(HooksV1).define(OwnerHooksV1);

  assert.equal(owner.services.use(HooksV1).define(OwnerHooksV1), handle);

  const registration = consumer.services
    .use(HooksV1)
    .use(OwnerHooksV1)
    .onThingHook(({ value }) => ({ value: value + 1 }));

  assert.deepEqual(await handle.onThingHook.execute({ value: 1 }), {
    value: 2,
  });

  registration.dispose();

  assert.deepEqual(await handle.onThingHook.execute({ value: 1 }), {
    value: 1,
  });
});

void test('hooks.use outside requires throws undeclared_requirement; whenAvailable stays optional', () => {
  const { principal } = setup();
  const GitHooksV1 = defineHooks('git.hooks/v1', {
    onSwitchHook: defineHook({ kind: 'observe', input: z.object({}).strict() }),
  });
  const usesHooks = { provides: new Map(), requires: new Set(['hooks/v1']) };

  principal('core').services.provide(createMinimalHooks());

  const optional = principal('optional', usesHooks).services.use(HooksV1);

  assert.throws(
    () => optional.use(GitHooksV1),
    codeOf('undeclared_requirement'),
  );
  // Platform hooks contracts never enter requires.
  optional.use(AppHooksV1);
  optional.whenAvailable(GitHooksV1, () => undefined).dispose();

  principal('declared', {
    provides: new Map(),
    requires: new Set(['hooks/v1', 'git.hooks/v1']),
  })
    .services.use(HooksV1)
    .use(GitHooksV1);
  principal('git', { ...usesHooks, ownContracts: new Set(['git.hooks/v1']) })
    .services.use(HooksV1)
    .use(GitHooksV1);
});
