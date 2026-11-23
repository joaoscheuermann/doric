// `host-config`'s host part over the router (phase 3, slice S45b; spec
// `docs/designs/grpc-processes.md`, section 4): `host-config/v1`, the
// settings space `host-config.configuration/v1` with its reference source
// for `secrets/v1`, and the configuration start step, served as
// `src/host/main.ts` lists them.
//
// The bundle under test runs in `createTestRouter`. Its dependencies are
// fakes that record what they receive, in one shared order: an in-memory
// `settings/v1` holding one `Any` of `ConfigurationValue`, `secrets/v1`,
// `models/v1`, `tools/v1`, `hooks/v1` and `doric.startup/v1`. `core`'s calls
// to the handler services arrive through `router.client` with the caller
// `core`. Today's answers come from the kernel store (`createConfigStore`)
// over the same value.

import assert from 'node:assert/strict';
import test, { describe, type TestContext } from 'node:test';

import {
  create,
  type DescService,
  fromJson,
  type JsonObject,
  type JsonValue,
  toJson,
} from '@bufbuild/protobuf';
import {
  type Any,
  anyPack,
  anyUnpack,
  ValueSchema,
} from '@bufbuild/protobuf/wkt';
import {
  ConnectError,
  createContextValues,
  type HandlerContext,
  type ServiceImpl,
} from '@connectrpc/connect';
import {
  type Caller,
  ContractError,
  defineSettings,
  fromConnectError,
  isContractError,
  type Settings,
} from 'bundle/contracts';
import {
  HookHandlerService,
  HooksService,
  RegisterRequestSchema as HookRegisterRequestSchema,
} from 'bundle/contracts/gen/doric/hooks/v1/hooks_pb.js';
import {
  ModelsService,
  PrepareRequestSchema,
} from 'bundle/contracts/gen/doric/models/v1/models_pb.js';
import { OnHostStartHookInputSchema } from 'bundle/contracts/gen/doric/platform/app/hooks/v1/hooks_pb.js';
import {
  LogRequestSchema,
  StageRequestSchema,
  StartupService,
} from 'bundle/contracts/gen/doric/platform/startup/v1/startup_pb.js';
import {
  ListResponseSchema as SecretsListResponseSchema,
  ReferenceSourceService,
  ReferenceSourceServiceListRequestSchema,
  RegisterReferencesRequestSchema,
  SecretsService,
} from 'bundle/contracts/gen/doric/secrets/v1/secrets_pb.js';
import {
  RegisterRequestSchema as SettingsRegisterRequestSchema,
  SettingsService,
} from 'bundle/contracts/gen/doric/settings/v1/settings_pb.js';
import {
  ListResponseSchema as ToolsListResponseSchema,
  ToolsService,
} from 'bundle/contracts/gen/doric/tools/v1/tools_pb.js';
import { createHookHandlers, type ServiceEntry } from 'bundle/host';
import { createTestRouter } from 'bundle/testing';

import { ConfigurationValueSchema } from '../src/contracts/gen/doric/host_config/configuration/v1/configuration_pb.js';
import {
  CurrentRequestSchema,
  DoricConfigurationSchema,
  HostConfigService,
  ReplaceRequestSchema,
} from '../src/contracts/gen/doric/host_config/v1/host_config_pb.js';
import {
  type ConfigInput,
  ConfigInputSchema,
  type DoricConfig,
  defaultConfig,
} from '../src/host/config/schema.js';
import { createConfigStore } from '../src/host/config/store.js';
import {
  type ConfigurationSettings,
  configurationSettingsId,
} from '../src/host/configuration.js';
import { createHostConfigServices } from '../src/host/service.js';

// ---------------------------------------------------------------------------
// Helpers

/** Resolves with `promise`'s value; fails the test after `timeoutMs`. */
const within = async <T>(
  promise: Promise<T>,
  what: string,
  timeoutMs = 3_000,
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out waiting for ${what}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/** Waits until `ready()` holds; fails the test after `timeoutMs`. */
const eventually = async (
  ready: () => boolean,
  what: string,
  timeoutMs = 3_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;

  while (!ready()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

/** Lets every pending call run that can run (several macrotasks). */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

/** The error `promise` rejects with; fails the test when it resolves. */
const rejectionOf = async (
  promise: Promise<unknown>,
  what = 'the call',
): Promise<unknown> => {
  try {
    await within(promise, what);
  } catch (error) {
    return error;
  }

  return assert.fail(`${what} succeeded`);
};

/** The Doric error of a failure: a `ContractError`, or read off a `ConnectError`. */
const contractErrorOf = (error: unknown): ContractError => {
  if (error instanceof ConnectError) return fromConnectError(error);

  assert.ok(isContractError(error), `expected a Doric error: ${error}`);

  return error;
};

/** Asserts `promise` fails with the Doric code `code`. */
const assertFails = async (
  promise: Promise<unknown>,
  code: string,
): Promise<void> => {
  const error = contractErrorOf(await rejectionOf(promise));

  assert.equal(error.code, code, error.message);
};

/** A promise a test holds a fake on, and the function that lets it go. */
interface Gate {
  readonly promise: Promise<void>;
  open(): void;
}

const deferred = (): Gate => {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    release = settle;
  });

  return { promise, open: () => release() };
};

/** A service entry that only defines the methods a test calls. */
const partial = <S extends DescService>(
  service: S,
  implementation: Partial<ServiceImpl<S>>,
): ServiceEntry => [service, implementation as ServiceImpl<S>] as ServiceEntry;

/** `core`, as the router stamps it on its calls to the handler services. */
const core: Caller = { bundleId: 'core', version: '1.0.0', generation: 1 };

// ---------------------------------------------------------------------------
// Fixtures

const PROVIDER_TOKEN = defaultConfig.providers[0]?.configuration.token ?? '';
const CLAUDE_TOKEN = '00000000-0000-4000-8000-000000000003';
const GIT_CREDENTIAL = '00000000-0000-4000-8000-000000000004';
const GITHUB_CREDENTIAL = '00000000-0000-4000-8000-000000000005';
const C9 = '00000000-0000-4000-8000-000000000009';

/** The stored credentials `secrets/v1.List` answers by default. */
const storedCredentials = [
  { id: PROVIDER_TOKEN, kind: 'API_TOKEN' },
  { id: CLAUDE_TOKEN, kind: 'API_TOKEN' },
  { id: GIT_CREDENTIAL, kind: 'GIT' },
  { id: GITHUB_CREDENTIAL, kind: 'API_TOKEN' },
  { id: C9, kind: 'GIT' },
];

const clone = (config: ConfigInput = defaultConfig): ConfigInput =>
  structuredClone(config) as ConfigInput;

/** `defaultConfig` with `maxTurns` set, to tell two replacements apart. */
const withMaxTurns = (maxTurns: number): ConfigInput => {
  const config = clone();

  return { ...config, execution: { ...config.execution, maxTurns } };
};

/**
 * A configuration that uses every part of the value: two providers stored out
 * of id order (`openrouter` then `anthropic`), models with and without
 * reasonings and catalog fields, a compaction policy that is off, a profile,
 * thread preferences and both credential ids.
 */
const fullConfig = (): ConfigInput => {
  const config = clone();

  return {
    ...config,
    providers: [
      ...config.providers,
      {
        id: 'anthropic',
        kind: 'claude',
        configuration: { token: CLAUDE_TOKEN },
        models: [
          {
            name: 'claude-sonnet',
            reasonings: ['low', 'high'],
            defaultEffort: 'high',
            mandatory: true,
          },
          { name: 'claude-haiku', reasonings: [] },
        ],
      },
    ],
    execution: {
      maxTurns: 40,
      maxToolResultChars: 20_000,
      contextCompaction: {
        enabled: false,
        pressurePercent: 80,
        tailMinMessages: 6,
        summaryMaxChars: 6000,
        charBudget: 200_000,
      },
    },
    tools: { web: { apiKey: 'k' } },
    gitCredentialId: GIT_CREDENTIAL,
    githubCredentialId: GITHUB_CREDENTIAL,
    profile: { name: 'Ana', timezone: 'America/Sao_Paulo' },
    threads: { autoArchive: { agentThreads: false, mainThreadsAfter: '30d' } },
  } as ConfigInput;
};

const updatedAtOf = (revision: number) =>
  new Date(revision * 1000).toISOString();

/**
 * Today's `GET /config` body for `value` stored at `revision`: the kernel
 * store (`createConfigStore`) over a `settings/v1` that holds it.
 */
const kernelBody = async (
  value: ConfigInput,
  revision: number,
): Promise<DoricConfig> => {
  const settings = {
    entry: async () => ({
      value: structuredClone(value),
      revision,
      version: '1.3.0',
      updatedAt: updatedAtOf(revision),
      generation: 1,
    }),
  } as unknown as Settings;

  return await createConfigStore({
    settings,
    definition: defineSettings({
      id: configurationSettingsId,
      schema: ConfigInputSchema,
    }) as unknown as ConfigurationSettings,
    track: () => undefined,
  }).load();
};

/** `value` as JSON, through `JSON.stringify` (what a `Struct` carries). */
const asJson = (value: unknown): JsonValue =>
  JSON.parse(JSON.stringify(value)) as JsonValue;

/** An `Any` of `ConfigurationValue` holding `config`. */
const packed = (config: ConfigInput): Any =>
  anyPack(
    ConfigurationValueSchema,
    fromJson(ConfigurationValueSchema, asJson(config)),
  );

/** The JSON of a stored `ConfigurationValue`. */
const valueJson = (value: Any): JsonValue => {
  const message = anyUnpack(value, ConfigurationValueSchema);

  assert.ok(
    message !== undefined,
    `not a ConfigurationValue: ${value.typeUrl}`,
  );

  return toJson(ConfigurationValueSchema, message);
};

/** What `config` stores as: providers in id order, `tools` always set. */
const storedForm = (config: ConfigInput): JsonValue =>
  toJson(
    ConfigurationValueSchema,
    fromJson(
      ConfigurationValueSchema,
      asJson({
        ...config,
        providers: [...config.providers].sort((left, right) =>
          left.id.localeCompare(right.id),
        ),
        tools: config.tools ?? {},
      }),
    ),
  );

// ---------------------------------------------------------------------------
// The harness

interface HarnessOptions {
  /** The space's value and revision before the test; absent: never written. */
  readonly stored?: { readonly value: ConfigInput; readonly revision: number };
  readonly credentials?: readonly { id: string; kind: string }[];
  /** The `tools/v1.List` answer's `tools`, as JSON. */
  readonly tools?: readonly JsonValue[];
  readonly settingsRegisterError?: ContractError;
  readonly getError?: ContractError;
  readonly secretsListError?: ContractError;
  readonly stageError?: ContractError;
  /** The error of the `n`th `models/v1.Prepare` (1-based), if any. */
  readonly prepareError?: (n: number) => ContractError | undefined;
  /** Awaited by the `n`th `settings/v1.Set` before it writes. */
  readonly setGate?: (n: number) => Promise<void>;
  /** The error of the `n`th `settings/v1.Set` (after its gate), if any. */
  readonly setError?: (n: number) => ContractError | undefined;
}

const harness = (options: HarnessOptions = {}) => {
  /** Every call the fakes received, in order, as `service.method`. */
  const calls: string[] = [];
  const registers: JsonValue[] = [];
  const sets: JsonValue[] = [];
  const setTypeUrls: string[] = [];
  const prepares: JsonValue[] = [];
  const startup: { method: string; request: JsonValue }[] = [];

  let space: { value: Any; revision: number; updatedAt: string } | undefined;

  /** Writes the space as another writer would, bypassing the bundle. */
  const store = (value: ConfigInput, revision: number) => {
    space = {
      value: packed(value),
      revision,
      updatedAt: updatedAtOf(revision),
    };
  };

  if (options.stored !== undefined)
    store(options.stored.value, options.stored.revision);

  const entryOf = () => {
    if (space === undefined)
      throw new ContractError('settings_missing', 'never written');

    return {
      value: space.value,
      revision: space.revision,
      version: '1.3.0',
      updatedAt: space.updatedAt,
      generation: 1,
    };
  };

  const requireSpace = (id: string) => {
    if (id !== 'host-config.configuration/v1')
      throw new ContractError('unknown_settings', `unknown space ${id}`);
  };

  let setCount = 0;
  let prepareCount = 0;

  const fakes: ServiceEntry[] = [
    partial(SettingsService, {
      register: (request) => {
        calls.push('settings.register');
        registers.push(toJson(SettingsRegisterRequestSchema, request));

        if (options.settingsRegisterError !== undefined)
          throw options.settingsRegisterError;

        return { registrationId: 'settings-1' };
      },
      entry: (request) => {
        calls.push('settings.entry');
        requireSpace(request.id);

        return { settingsEntry: entryOf() };
      },
      get: (request) => {
        calls.push('settings.get');
        if (options.getError !== undefined) throw options.getError;
        requireSpace(request.id);

        return { value: entryOf().value };
      },
      set: async (request) => {
        calls.push('settings.set');
        requireSpace(request.id);
        setCount += 1;
        const n = setCount;

        if (request.value !== undefined) {
          sets.push(valueJson(request.value));
          setTypeUrls.push(request.value.typeUrl);
        }

        await options.setGate?.(n);

        const error = options.setError?.(n);
        if (error !== undefined) throw error;

        const revision = (space?.revision ?? 0) + 1;

        space = {
          value: request.value ?? packed(defaultConfig),
          revision,
          updatedAt: updatedAtOf(revision),
        };

        return { settingsEntry: entryOf() };
      },
    }),
    partial(SecretsService, {
      list: () => {
        calls.push('secrets.list');
        if (options.secretsListError !== undefined)
          throw options.secretsListError;

        return fromJson(SecretsListResponseSchema, {
          credentials: (options.credentials ?? storedCredentials).map(
            ({ id, kind }) => ({ id, kind, name: id, hasSecret: true }),
          ),
        });
      },
      registerReferences: (request) => {
        calls.push('secrets.registerReferences');
        registers.push(toJson(RegisterReferencesRequestSchema, request));

        return { registrationId: 'references-1' };
      },
    }),
    partial(ModelsService, {
      kind: () => {
        calls.push('models.kind');

        return {};
      },
      catalog: () => {
        calls.push('models.catalog');

        return { catalogResult: { status: 'absent' } };
      },
      prepare: (request) => {
        calls.push('models.prepare');
        prepares.push(toJson(PrepareRequestSchema, request));
        prepareCount += 1;

        const error = options.prepareError?.(prepareCount);
        if (error !== undefined) throw error;

        return {};
      },
    }),
    partial(ToolsService, {
      list: () => {
        calls.push('tools.list');

        return fromJson(ToolsListResponseSchema, {
          tools: [...(options.tools ?? [])],
        });
      },
    }),
    partial(HooksService, {
      register: (request) => {
        calls.push('hooks.register');
        registers.push(toJson(HookRegisterRequestSchema, request));

        return { registrationId: 'hook-1' };
      },
      unregister: () => ({}),
    }),
    partial(StartupService, {
      stage: (request) => {
        calls.push('startup.stage');
        startup.push({
          method: 'stage',
          request: toJson(StageRequestSchema, request),
        });
        if (options.stageError !== undefined) throw options.stageError;

        return {};
      },
      log: (request) => {
        calls.push('startup.log');
        startup.push({
          method: 'log',
          request: toJson(LogRequestSchema, request),
        });

        return {};
      },
    }),
  ];

  const router = createTestRouter({
    fakes,
    // Section D's lists; `doric.startup/v1` is a platform contract, declared
    // without a line, as `routeCall` step 3 has it.
    requires: [
      HooksService.typeName,
      SettingsService.typeName,
      SecretsService.typeName,
      ModelsService.typeName,
      ToolsService.typeName,
    ],
  });

  // `main.ts`'s definition.
  const hooks = createHookHandlers();
  const config = createHostConfigServices();
  const definition = {
    services: [
      [HostConfigService, config.implementations.hostConfig],
      [ReferenceSourceService, config.implementations.references],
      [HookHandlerService, hooks.implementation],
    ] as ServiceEntry[],
    activate: (context: Parameters<typeof config.activate>[0]) =>
      config.activate(context, hooks),
  };

  return {
    calls,
    registers,
    sets,
    setTypeUrls,
    prepares,
    startup,
    store,
    /** Activates the definition; resolves once `activate` resolved. */
    start: () =>
      within(router.activate<readonly DescService[]>(definition), 'activate'),
    /** `activate` as is, for a test that expects it to fail. */
    activate: () => router.activate<readonly DescService[]>(definition),
    hostConfig: () => router.client(HostConfigService, { caller: core }),
    references: () => router.client(ReferenceSourceService, { caller: core }),
    hookHandler: () => router.client(HookHandlerService, { caller: core }),
    stop: () => router.control.stop(),
  };
};

type Harness = ReturnType<typeof harness>;

/** A started harness, stopped when the test ends. */
const started = async (
  t: TestContext,
  options: HarnessOptions = {},
): Promise<Harness> => {
  const h = harness(options);

  t.after(() => h.stop());
  await h.start();

  return h;
};

const replace = (h: Harness, input: unknown) =>
  within(
    h.hostConfig().replace({ input: fromJson(ValueSchema, asJson(input)) }),
    'Replace',
  );

const referenceIds = async (h: Harness, source = 'configuration') =>
  [
    ...(await within(h.references().list({ source }), 'ReferenceSource.List'))
      .credentialIds,
  ].sort();

const handleStart = (h: Harness) =>
  h.hookHandler().handle({
    contract: 'doric.app.hooks/v1',
    hook: 'onHostStartHook',
    input: anyPack(
      OnHostStartHookInputSchema,
      create(OnHostStartHookInputSchema),
    ),
  });

/** The calls of a replacement, without the store's load and catalog reads. */
const pipeline = (calls: readonly string[]) =>
  calls.filter(
    (call) =>
      call !== 'settings.entry' &&
      call !== 'settings.get' &&
      call !== 'models.catalog',
  );

// ---------------------------------------------------------------------------
// Activation

describe('activate', () => {
  test('B1: activate registers the space, the reference source and the start hook, in that order, and reads nothing', async (t) => {
    const h = await started(t, { stored: { value: clone(), revision: 1 } });

    assert.deepEqual(h.calls, [
      'settings.register',
      'secrets.registerReferences',
      'hooks.register',
    ]);
    assert.deepEqual(h.registers, [
      {
        id: 'host-config.configuration/v1',
        messageType: 'doric.host_config.configuration.v1.ConfigurationValue',
      },
      { source: 'configuration' },
      { contract: 'doric.app.hooks/v1', hook: 'onHostStartHook' },
    ]);
  });

  test("B2: activate rejects with settings/v1.Register's error and sends nothing after it", async (t) => {
    const h = harness({
      settingsRegisterError: new ContractError('invalid_input', 'refused'),
    });

    t.after(() => h.stop());

    await assertFails(h.activate(), 'invalid_input');
    assert.deepEqual(h.calls, ['settings.register']);
  });
});

// ---------------------------------------------------------------------------
// host-config/v1.Current

describe('Current', () => {
  test("B3: Current answers the stored configuration whose JSON is today's GET /config body", async (t) => {
    for (const value of [clone(), fullConfig()]) {
      const h = await started(t, { stored: { value, revision: 4 } });

      const response = await within(h.hostConfig().current({}), 'Current');

      assert.ok(response.doricConfiguration !== undefined);
      assert.deepEqual(
        toJson(DoricConfigurationSchema, response.doricConfiguration, {
          alwaysEmitImplicit: true,
        }),
        asJson(await kernelBody(value, 4)),
      );
    }
  });

  test('B3: the JSON keeps providers in id order, tools, empty reasonings and a compaction policy that is off', async (t) => {
    const h = await started(t, {
      stored: { value: fullConfig(), revision: 4 },
    });

    const response = await within(h.hostConfig().current({}), 'Current');

    assert.ok(response.doricConfiguration !== undefined);
    const body = toJson(DoricConfigurationSchema, response.doricConfiguration, {
      alwaysEmitImplicit: true,
    }) as JsonObject;
    const configuration = body.configuration as JsonObject;
    const providers = configuration.providers as JsonObject[];

    assert.deepEqual(
      providers.map(({ id }) => id),
      ['anthropic', 'openrouter'],
    );
    assert.deepEqual(configuration.tools, { web: { apiKey: 'k' } });
    assert.deepEqual(
      (configuration.execution as JsonObject).contextCompaction,
      {
        enabled: false,
        pressurePercent: 80,
        tailMinMessages: 6,
        summaryMaxChars: 6000,
        charBudget: 200_000,
      },
    );
    const anthropic = providers[0];
    assert.ok(anthropic !== undefined);
    const haiku = (anthropic.models as JsonObject[])[1];
    assert.deepEqual(haiku, { name: 'claude-haiku', reasonings: [] });
    assert.equal(body.revision, 4);
    assert.equal(body.updatedAt, updatedAtOf(4));
  });

  test('B4: Current before the first write fails with settings_missing; after a write the next Current reads again and answers it', async (t) => {
    const h = await started(t);

    await assertFails(h.hostConfig().current({}), 'settings_missing');

    h.store(clone(), 1);

    const response = await within(h.hostConfig().current({}), 'Current');

    assert.equal(response.doricConfiguration?.revision, 1);
    assert.equal(
      response.doricConfiguration?.configuration?.execution?.maxTurns,
      defaultConfig.execution.maxTurns,
    );
  });
});

// ---------------------------------------------------------------------------
// host-config/v1.Replace

describe('Replace', () => {
  test('B5: a valid Replace lists credentials, describes kinds, lists tools, prepares, writes the sorted value, then prepares the stored snapshot', async (t) => {
    const h = await started(t, { stored: { value: clone(), revision: 1 } });
    // Two providers out of id order, and no `tools`.
    const { tools: _tools, profile: _profile, ...input } = fullConfig();

    const response = await replace(h, input);

    assert.equal(response.status.case, 'replaced');
    assert.deepEqual(pipeline(h.calls).slice(3), [
      'secrets.list',
      'models.kind',
      'models.kind',
      'tools.list',
      'models.prepare',
      'settings.set',
      'models.prepare',
    ]);
    assert.deepEqual(h.setTypeUrls, [
      'type.googleapis.com/doric.host_config.configuration.v1.ConfigurationValue',
    ]);
    assert.deepEqual(h.sets, [storedForm(input)]);

    const stored: ConfigInput = { ...input, tools: {} };

    assert.deepEqual(h.prepares[1], {
      configuration: asJson(await kernelBody(stored, 2)),
    });
    if (response.status.case === 'replaced')
      assert.equal(response.status.value.config?.revision, 2);
  });

  test('B6: an input the schema refuses answers invalid and makes no router call', async (t) => {
    const h = await started(t, { stored: { value: clone(), revision: 1 } });
    const before = h.calls.length;

    const response = await replace(h, { providers: [] });

    assert.equal(response.status.case, 'invalid');
    assert.equal(
      response.status.value?.message,
      'The Doric configuration is invalid.',
    );
    assert.deepEqual(h.calls.slice(before), []);
  });

  test('B7: a credential that List lacks, or of the wrong kind, answers invalid with today’s message and writes nothing', async (t) => {
    const h = await started(t, {
      stored: { value: clone(), revision: 1 },
      credentials: [
        { id: GIT_CREDENTIAL, kind: 'API_TOKEN' },
        { id: PROVIDER_TOKEN, kind: 'API_TOKEN' },
      ],
    });

    const missing = clone();
    const provider = missing.providers[0];
    assert.ok(provider !== undefined);
    provider.configuration = { ...provider.configuration, token: C9 };

    const unstored = await replace(h, missing);

    assert.equal(unstored.status.case, 'invalid');
    assert.equal(
      unstored.status.value?.message,
      'Provider openrouter token references a credential that is not stored.',
    );

    const misKinded = await replace(h, {
      ...clone(),
      gitCredentialId: GIT_CREDENTIAL,
    });

    assert.equal(misKinded.status.case, 'invalid');
    assert.equal(
      misKinded.status.value?.message,
      'The Git identity must reference a GIT credential, not a API_TOKEN one.',
    );
    assert.equal(h.calls.includes('settings.set'), false);
  });

  test('B8: a required tool field without a value answers invalid "Tool web requires a apiKey value." and writes nothing', async (t) => {
    const h = await started(t, {
      stored: { value: clone(), revision: 1 },
      tools: [
        {
          bundleId: 'web',
          alwaysAvailable: true,
          tool: {
            name: 'web',
            definition: { name: 'web', inputSchema: '{}', outputSchema: '{}' },
            settings: [{ key: 'apiKey', required: true }],
          },
        },
      ],
    });

    const response = await replace(h, clone());

    assert.equal(response.status.case, 'invalid');
    assert.equal(
      response.status.value?.message,
      'Tool web requires a apiKey value.',
    );
    assert.equal(h.calls.includes('settings.set'), false);
  });

  test('B9: a failing Prepare of the candidate answers rejected, writes nothing and keeps the active configuration', async (t) => {
    const h = await started(t, {
      stored: { value: clone(), revision: 1 },
      prepareError: (n) =>
        n === 1 ? new ContractError('unavailable', 'no provider') : undefined,
    });

    const response = await replace(h, withMaxTurns(10));

    assert.equal(response.status.case, 'rejected');
    assert.equal(h.calls.includes('settings.set'), false);

    const current = await within(h.hostConfig().current({}), 'Current');

    assert.equal(current.doricConfiguration?.revision, 1);
    assert.equal(
      current.doricConfiguration?.configuration?.execution?.maxTurns,
      defaultConfig.execution.maxTurns,
    );
  });

  test('B9: a failing secrets/v1.List answers rejected', async (t) => {
    const h = await started(t, {
      stored: { value: clone(), revision: 1 },
      secretsListError: new ContractError('unavailable', 'no secrets'),
    });

    const response = await replace(h, withMaxTurns(10));

    assert.equal(response.status.case, 'rejected');
    assert.equal(h.calls.includes('settings.set'), false);
  });

  test("B10: two Replaces run in request order: the second's List starts only after the first's Set settled, and the Sets arrive in order", async (t) => {
    const gate = deferred();
    const listsWhenFirstSetSettled: number[] = [];
    const count = (call: string) => h.calls.filter((c) => c === call).length;
    const h = await started(t, {
      stored: { value: clone(), revision: 1 },
      setGate: (n) =>
        n === 1
          ? gate.promise.then(() => {
              listsWhenFirstSetSettled.push(count('secrets.list'));
            })
          : Promise.resolve(),
    });

    const first = replace(h, withMaxTurns(10));

    await eventually(() => h.calls.includes('settings.set'), 'the first Set');

    const second = replace(h, withMaxTurns(20));

    await settle();
    assert.equal(count('secrets.list'), 1, 'the second List started early');

    gate.open();

    const [one, two] = await Promise.all([first, second]);

    assert.equal(one.status.case, 'replaced');
    assert.equal(two.status.case, 'replaced');
    assert.deepEqual(listsWhenFirstSetSettled, [1]);
    assert.equal(count('secrets.list'), 2);
    assert.deepEqual(
      h.sets.map(
        (value) => ((value as JsonObject).execution as JsonObject).maxTurns,
      ),
      [10, 20],
    );
  });
});

// ---------------------------------------------------------------------------
// ReferenceSourceService.List

describe('ReferenceSourceService', () => {
  test('B11: List answers the stored configuration’s secret ids, git and github credential ids, each once', async (t) => {
    const value = fullConfig();
    // The GitHub token is also a provider's: it is answered once.
    value.githubCredentialId = CLAUDE_TOKEN;
    const h = await started(t, { stored: { value, revision: 3 } });

    assert.deepEqual(
      await referenceIds(h),
      [PROVIDER_TOKEN, CLAUDE_TOKEN, GIT_CREDENTIAL].sort(),
    );
    assert.equal(h.calls.includes('settings.get'), true);
  });

  test('B11: with the space unwritten List answers no ids', async (t) => {
    const h = await started(t);

    assert.deepEqual(await referenceIds(h), []);
  });

  test('B11: a Get failing with unavailable fails List with unavailable', async (t) => {
    const h = await started(t, {
      stored: { value: clone(), revision: 1 },
      getError: new ContractError('unavailable', 'core restarting'),
    });

    await assertFails(
      h.references().list({ source: 'configuration' }),
      'unavailable',
    );
  });

  test('B12: while a Replace naming c9 is held at Set, List includes c9; after it answered, List answers the stored ids', async (t) => {
    const gate = deferred();
    const h = await started(t, {
      stored: { value: clone(), revision: 1 },
      setGate: () => gate.promise,
    });

    const pending = replace(h, { ...clone(), gitCredentialId: C9 });

    await eventually(() => h.calls.includes('settings.set'), 'the Set');
    assert.deepEqual(await referenceIds(h), [PROVIDER_TOKEN, C9].sort());

    gate.open();
    assert.equal((await pending).status.case, 'replaced');
    assert.deepEqual(await referenceIds(h), [PROVIDER_TOKEN, C9].sort());
  });

  test('B12: when the held Set fails, List no longer answers c9 after the Replace answered', async (t) => {
    const gate = deferred();
    const h = await started(t, {
      stored: { value: clone(), revision: 1 },
      setGate: () => gate.promise,
      setError: () => new ContractError('unavailable', 'write failed'),
    });

    const pending = replace(h, { ...clone(), gitCredentialId: C9 });

    await eventually(() => h.calls.includes('settings.set'), 'the Set');
    assert.deepEqual(await referenceIds(h), [PROVIDER_TOKEN, C9].sort());

    gate.open();
    assert.equal((await pending).status.case, 'rejected');
    assert.deepEqual(await referenceIds(h), [PROVIDER_TOKEN]);
  });

  test('B13: List of another source answers no ids', async (t) => {
    const h = await started(t, {
      stored: { value: fullConfig(), revision: 1 },
    });

    assert.deepEqual(await referenceIds(h, 'other'), []);
  });
});

// ---------------------------------------------------------------------------
// The start step

describe('start step', () => {
  test('B14: onHostStartHook stages, logs, reads the space, prepares the snapshot and logs the activated configuration, in order, and answers {}', async (t) => {
    const value = fullConfig();
    const h = await started(t, { stored: { value, revision: 4 } });
    const before = h.calls.length;

    const response = await within(handleStart(h), 'Handle onHostStartHook');

    assert.equal(response.output, undefined);
    assert.equal(response.decision, undefined);
    assert.deepEqual(h.calls.slice(before), [
      'startup.stage',
      'startup.log',
      'settings.entry',
      'models.prepare',
      'startup.log',
    ]);

    const snapshot = await kernelBody(value, 4);
    const normalized = h.startup.map(({ method, request }) =>
      method === 'log'
        ? {
            method,
            request: {
              ...(request as JsonObject),
              fields: (request as JsonObject).fields ?? {},
            },
          }
        : { method, request },
    );

    assert.deepEqual(normalized, [
      { method: 'stage', request: { name: 'configuration_activation' } },
      {
        method: 'log',
        request: {
          level: 'info',
          message: 'Activating Doric configuration',
          fields: {},
        },
      },
      {
        method: 'log',
        request: {
          level: 'info',
          message: 'Doric configuration activated',
          fields: asJson({
            configRevision: 4,
            providerCount: 2,
            executionModel: snapshot.configuration.models.execution,
            maxTurns: 40,
          }),
        },
      },
    ]);
    assert.deepEqual(h.prepares, [{ configuration: asJson(snapshot) }]);
  });

  test('B15: a failing Stage fails Handle with its error, and nothing is read or prepared', async (t) => {
    const h = await started(t, {
      stored: { value: clone(), revision: 1 },
      stageError: new ContractError('unavailable', 'no startup record'),
    });

    await assertFails(handleStart(h), 'unavailable');
    assert.equal(h.calls.includes('settings.entry'), false);
    assert.equal(h.calls.includes('models.prepare'), false);
  });

  test('B15: with the space unwritten Handle fails with settings_missing', async (t) => {
    const h = await started(t);

    await assertFails(handleStart(h), 'settings_missing');
    assert.equal(h.calls.includes('models.prepare'), false);
  });
});

// ---------------------------------------------------------------------------
// Before activate

describe('before activate', () => {
  /** A handler context as a served call would have it. */
  const handlerContext = () =>
    ({
      signal: new AbortController().signal,
      values: createContextValues(),
      requestHeader: new Headers(),
      responseHeader: new Headers(),
      responseTrailer: new Headers(),
      timeoutMs: () => undefined,
    }) as unknown as HandlerContext;

  test('B16: Current, Replace and ReferenceSource.List answer unavailable before activate', async () => {
    const { implementations } = createHostConfigServices();

    await assertFails(
      Promise.resolve().then(() =>
        implementations.hostConfig.current(
          create(CurrentRequestSchema),
          handlerContext(),
        ),
      ),
      'unavailable',
    );
    await assertFails(
      Promise.resolve().then(() =>
        implementations.hostConfig.replace(
          create(ReplaceRequestSchema, {
            input: fromJson(ValueSchema, asJson(defaultConfig)),
          }),
          handlerContext(),
        ),
      ),
      'unavailable',
    );
    await assertFails(
      Promise.resolve().then(() =>
        implementations.references.list(
          create(ReferenceSourceServiceListRequestSchema, {
            source: 'configuration',
          }),
          handlerContext(),
        ),
      ),
      'unavailable',
    );
  });
});
