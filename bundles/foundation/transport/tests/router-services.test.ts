// `transport`'s small `doric.api.*` services through the router (phase 3,
// S60c, contract s60 §2.10, §3.1–3.4, §3.7, §3.8, tests R0, R-config, R-cred,
// R-prov, R-host, R-term, R-status, R-deadline, the start step of Q5, P1 for
// these services — each refusal of the removed `host-routes.test.ts` ends the
// RPC with the route's code as reason, its message, and §5's gRPC code, stated
// per case — and M1/M2 in process). The harness is `./support/router.ts`; the
// fakes answer that suite's domain values (`./support/router-fakes.ts`).

import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import {
  create,
  type JsonObject,
  type JsonValue,
  toJson,
} from '@bufbuild/protobuf';
import { anyPack } from '@bufbuild/protobuf/wkt';
import { Code } from '@connectrpc/connect';
import { ContractError } from 'bundle/contracts';
import { OnHostStartHookInputSchema } from 'bundle/contracts/gen/doric/platform/app/hooks/v1/hooks_pb.js';
import { providerKind, providerKinds } from 'llms';

import {
  GetConfigResponseSchema,
  PutConfigResponseSchema,
} from '../src/contracts/gen/doric/api/config/v1/config_pb.js';
import {
  CreateCredentialResponseSchema,
  DeleteCredentialResponseSchema,
  ListCredentialsResponseSchema,
  UpdateCredentialResponseSchema,
} from '../src/contracts/gen/doric/api/credentials/v1/credentials_pb.js';
import {
  GetVmSshResponseSchema,
  ListResourcesResponseSchema,
  ListToolsResponseSchema,
  ListVmsResponseSchema,
} from '../src/contracts/gen/doric/api/host/v1/host_pb.js';
import {
  ListKindsResponseSchema,
  ListModelsResponseSchema,
} from '../src/contracts/gen/doric/api/providers/v1/providers_pb.js';
import { WatchResponseSchema } from '../src/contracts/gen/doric/api/status/v1/status_pb.js';
import { GetTerminalResponseSchema } from '../src/contracts/gen/doric/api/terminals/v1/terminals_pb.js';
import {
  API_SERVICES,
  type Harness,
  type HarnessOptions,
  harness,
} from './support/router.js';
import { type Fakes, routerFakes } from './support/router-fakes.js';
import {
  access,
  activated,
  assertMessage,
  catalogEntry,
  configuration,
  credentialId,
  described,
  first,
  providerConfiguration,
  type Refusal,
  reading,
  refusalOf,
  secret,
  sleep,
  snapshot,
  terminal,
  terminalSnapshot,
  toolEntries,
  vms,
} from './support/router-fixtures.js';

/** The harness over the domain fakes `fakes`, activated for one test. */
const served = (
  t: TestContext,
  fakes: Fakes = {},
  options: Omit<HarnessOptions, 'fakes'> = {},
): Promise<Harness> =>
  activated(t, { ...options, fakes: (record) => routerFakes(record, fakes) });

const requestsOf = (h: Harness, method: string): JsonValue[] =>
  h.calls.filter((call) => call.method === method).map((call) => call.request);

const struct = (value: unknown) => value as JsonObject;

const refused = (reason: string, message: string, code: Code): Refusal => ({
  reason,
  message,
  code,
});

const notActive = refused(
  'unavailable',
  'transport is not active.',
  Code.Unavailable,
);
const internal = refused(
  'internal_error',
  'The request could not be completed.',
  Code.Internal,
);

/** One valid call of every method of the S60c services. */
const everyMethod = (
  h: Harness,
): readonly (readonly [string, () => Promise<unknown>])[] => [
  ['GetConfig', () => h.config().getConfig({})],
  [
    'PutConfig',
    () => h.config().putConfig({ configuration: struct(configuration) }),
  ],
  ['ListCredentials', () => h.credentials().listCredentials({})],
  [
    'CreateCredential',
    () =>
      h
        .credentials()
        .createCredential({ kind: 'API_TOKEN', name: 'key', secret }),
  ],
  [
    'UpdateCredential',
    () => h.credentials().updateCredential({ credentialId, name: 'x' }),
  ],
  [
    'DeleteCredential',
    () => h.credentials().deleteCredential({ credentialId }),
  ],
  ['ListKinds', () => h.providers().listKinds({})],
  [
    'ListModels',
    () =>
      h.providers().listModels({
        kind: 'openrouter',
        configuration: providerConfiguration,
      }),
  ],
  ['ListTools', () => h.hostApi().listTools({})],
  ['ListResources', () => h.hostApi().listResources({})],
  ['ListVms', () => h.hostApi().listVms({})],
  ['GetVmSsh', () => h.hostApi().getVmSsh({ vmId: 'vm-1' })],
  [
    'GetTerminal',
    () => h.terminals().getTerminal({ terminalId: 'terminal-1' }),
  ],
  [
    'SendInput',
    () => h.terminals().sendInput({ terminalId: 'terminal-1', data: 'x' }),
  ],
  [
    'Resize',
    () => h.terminals().resize({ terminalId: 'terminal-1', cols: 1, rows: 1 }),
  ],
  [
    'DeleteTerminal',
    () => h.terminals().deleteTerminal({ terminalId: 'terminal-1' }),
  ],
  ['StatusWatch', () => first(h.status().watch({}))],
];

const everyFake: Fakes = {
  configuration: {
    current: () => snapshot(1),
    replace: () => ({ status: 'replaced', config: snapshot(2) }),
  },
  secrets: {
    list: () => [described],
    create: () => described,
    update: () => described,
    delete: () => 'deleted',
  },
  models: {
    kinds: () => providerKinds,
    kind: (id: string) => providerKind(id),
    catalog: () => ({ status: 'read', models: [catalogEntry] }),
  },
  tools: { list: () => [] },
  resources: { host: () => reading },
  sandbox: { machines: () => vms, machine: () => vms[0] },
  runtime: { vmSsh: () => ({ projectId: 'p', ssh: access }) },
  terminal: {
    snapshot: () => terminalSnapshot,
    input: () => true,
    resize: () => true,
    stop: () => true,
  },
};

const assertAllNotActive = async (h: Harness): Promise<void> => {
  for (const [name, call] of everyMethod(h)) {
    assert.deepEqual(await refusalOf(call()), notActive, name);
  }
};

// R0 ------------------------------------------------------------------------

void test('R0: before activate every method answers UNAVAILABLE unavailable "transport is not active."', async (t) => {
  const h = harness({ fakes: (record) => routerFakes(record, everyFake) });

  t.after(() => h.router.control.stop());
  await h.serveWithoutActivate();

  await assertAllNotActive(h);
  assert.deepEqual(h.calls, []);
});

void test('R0: a hooks/v1 refusal of the start step rejects activate with it, and every method then answers unavailable', async (t) => {
  const h = harness({
    fakes: (record) => routerFakes(record, everyFake),
    hookRegisterError: new ContractError('registration_conflict', 'taken'),
  });

  t.after(() => h.router.control.stop());

  assert.equal((await refusalOf(h.activate())).reason, 'registration_conflict');
  await assertAllNotActive(h);
  assert.deepEqual(h.calls, []);
});

void test('R0: after deactivate every method answers unavailable; deactivate never rejects, twice or before activate', async (t) => {
  const h = await served(t, everyFake);

  await h.host.deactivate();
  await h.host.deactivate();
  await assertAllNotActive(h);

  const fresh = harness();

  t.after(() => fresh.router.control.stop());
  await fresh.host.deactivate();
});

void test('R0: deactivate ends an open StatusService.Watch with unavailable', async (t) => {
  const h = await served(t);
  const stream = h.status().watch({})[Symbol.asyncIterator]();
  const ready = await stream.next();

  assert.equal(ready.done, false);
  const next = stream.next();

  await h.host.deactivate();
  assert.deepEqual(await refusalOf(next), notActive);
});

// The start step (Q5) ------------------------------------------------------

void test('Q5: activate registers only the onHostStartHook step and calls no consumed service', async (t) => {
  const h = await served(t, everyFake);

  assert.deepEqual(h.hookRegisters, [
    { contract: 'doric.app.hooks/v1', hook: 'onHostStartHook' },
  ]);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.startup, []);
});

void test('Q5: the start step logs "Network interfaces configured" with the eight apiServices', async (t) => {
  const h = await served(t);

  await h.hooks().handle({
    contract: 'doric.app.hooks/v1',
    hook: 'onHostStartHook',
    input: anyPack(
      OnHostStartHookInputSchema,
      create(OnHostStartHookInputSchema),
    ),
  });

  const logs = h.startup
    .filter(({ method }) => method === 'log')
    .map(({ request }) => request as { readonly [key: string]: JsonValue });

  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.level, 'info');
  assert.equal(logs[0]?.message, 'Network interfaces configured');
  const fields = logs[0]?.fields as { readonly apiServices?: string[] };

  assert.deepEqual(
    [...(fields.apiServices ?? [])].sort(),
    [...API_SERVICES].sort(),
  );
});

// R-config ------------------------------------------------------------------

void test('R-config: GetConfig answers {doricConfiguration} from host-config/v1.Current', async (t) => {
  const h = await served(t, {
    configuration: { current: () => snapshot(1) },
  });
  const response = await h.config().getConfig({});

  assertMessage(GetConfigResponseSchema, response, {
    doricConfiguration: snapshot(1),
  });
});

void test("R-config: PutConfig passes the Struct's JSON to Replace and answers the replacement", async (t) => {
  const h = await served(t, {
    configuration: {
      replace: () => ({ status: 'replaced', config: snapshot(2) }),
    },
  });
  const response = await h
    .config()
    .putConfig({ configuration: struct(configuration) });

  assertMessage(PutConfigResponseSchema, response, {
    doricConfiguration: snapshot(2),
  });
  assert.deepEqual(requestsOf(h, 'hostConfig.replace'), [
    { input: configuration },
  ]);
});

void test("R-config/P1: an invalid configuration answers invalid_config with host-config's message", async (t) => {
  for (const message of [
    'The Doric configuration is invalid.',
    'Provider openrouter must reference an API_TOKEN credential, not a GIT one.',
  ]) {
    const h = await served(t, {
      configuration: { replace: () => ({ status: 'invalid', message }) },
    });

    assert.deepEqual(
      await refusalOf(
        h.config().putConfig({ configuration: struct({ providers: [] }) }),
      ),
      refused('invalid_config', message, Code.InvalidArgument),
    );
  }
});

void test('R-config/P1: any other Replace answer or failure is configuration_rejected UNAVAILABLE, without its cause', async (t) => {
  for (const replace of [
    () => ({ status: 'rejected' }),
    () => {
      throw new Error('provider secret');
    },
    () => {
      throw new ContractError('unavailable', 'provider secret');
    },
  ]) {
    const h = await served(t, { configuration: { replace } });
    const refusal = await refusalOf(
      h.config().putConfig({ configuration: struct(configuration) }),
    );

    assert.deepEqual(
      refusal,
      refused(
        'configuration_rejected',
        'The Doric configuration could not be activated.',
        Code.Unavailable,
      ),
    );
  }
});

// R-cred --------------------------------------------------------------------

void test('R-cred: ListCredentials answers every credential without its secret', async (t) => {
  const h = await served(t, { secrets: { list: () => [described] } });
  const response = await h.credentials().listCredentials({});

  assertMessage(ListCredentialsResponseSchema, response, {
    credentials: [described],
  });
});

void test('R-cred: CreateCredential creates the normalised credential (201 case) and answers it without the secret', async (t) => {
  const h = await served(t, {
    secrets: {
      create: (input: { name: string }) => ({ ...described, name: input.name }),
    },
  });
  const response = await h.credentials().createCredential({
    kind: 'API_TOKEN',
    name: '  openrouter  ',
    secret,
  });

  assertMessage(CreateCredentialResponseSchema, response, {
    credentialDescription: described,
  });
  assert.equal(
    JSON.stringify(toJson(CreateCredentialResponseSchema, response)).includes(
      secret,
    ),
    false,
  );
  assert.deepEqual(requestsOf(h, 'secrets.create'), [
    { kind: 'API_TOKEN', name: 'openrouter', secret },
  ]);
});

void test('R-cred/P1: a create body that does not fit its kind is invalid_credential, and nothing is created', async (t) => {
  const h = await served(t, { secrets: { create: () => described } });

  for (const body of [
    { kind: 'API_TOKEN', name: 'openrouter' },
    { kind: 'GIT', name: 'github', username: 'octocat', secret },
    { kind: 'OTHER', name: 'openrouter', secret },
  ]) {
    assert.deepEqual(
      await refusalOf(h.credentials().createCredential(body)),
      refused(
        'invalid_credential',
        'The credential does not match its kind.',
        Code.InvalidArgument,
      ),
      JSON.stringify(body),
    );
  }
  assert.deepEqual(requestsOf(h, 'secrets.create'), []);
});

void test('R-cred: UpdateCredential updates by id, clearing with "" and keeping what is absent', async (t) => {
  const h = await served(t, {
    secrets: {
      update: (_ref: unknown, input: { name?: string }) => ({
        ...described,
        name: input.name ?? described.name,
      }),
    },
  });
  const response = await h.credentials().updateCredential({
    credentialId,
    name: 'renamed',
    username: '',
  });

  assertMessage(UpdateCredentialResponseSchema, response, {
    credentialDescription: { ...described, name: 'renamed' },
  });
  assert.deepEqual(requestsOf(h, 'secrets.update'), [
    { ref: { id: credentialId }, update: { name: 'renamed', username: '' } },
  ]);
});

void test('R-cred/P1: each secrets/v1 refusal of an update answers the route reason, message and code', async (t) => {
  const h = await served(t, {
    secrets: {
      update: (_ref: unknown, input: { kind?: string; name?: string }) => {
        if (input.kind !== undefined) {
          throw new ContractError('credential_kind_immutable', 'Refused.');
        }
        if (input.name === 'taken') {
          throw new ContractError('credential_name_taken', 'Refused.');
        }
        if (input.name === 'empty') {
          throw new ContractError(
            'credential_invalid',
            'A GIT credential requires username, email and carries no other field.',
          );
        }
        if (input.name === 'unknown') {
          throw new ContractError('unknown_kind', 'No such kind.');
        }
        if (input.name === 'gone') {
          throw new ContractError('credential_missing', 'Refused.');
        }

        return described;
      },
    },
  });

  for (const [change, expected] of [
    [
      { kind: 'GIT' },
      refused(
        'credential_kind_immutable',
        'The credential cannot perform this operation.',
        Code.FailedPrecondition,
      ),
    ],
    [
      { name: 'taken' },
      refused(
        'credential_name_taken',
        'The credential cannot perform this operation.',
        Code.AlreadyExists,
      ),
    ],
    [
      { name: 'empty' },
      refused(
        'invalid_credential',
        'A GIT credential requires username, email and carries no other field.',
        Code.InvalidArgument,
      ),
    ],
    [
      { name: 'unknown' },
      refused('invalid_credential', 'No such kind.', Code.InvalidArgument),
    ],
    [
      { name: 'gone' },
      refused(
        'credential_not_found',
        'The credential was not found.',
        Code.NotFound,
      ),
    ],
  ] as const) {
    assert.deepEqual(
      await refusalOf(
        h.credentials().updateCredential({ credentialId, ...change }),
      ),
      expected,
      JSON.stringify(change),
    );
  }
});

void test('R-cred/P1: an unusable host key is credential_storage_unavailable; any other failure internal_error without the secret', async (t) => {
  const h = await served(t, {
    secrets: {
      create: () => {
        throw new ContractError('credential_storage_unavailable', 'no key');
      },
      update: () => {
        throw new Error(secret);
      },
    },
  });

  assert.deepEqual(
    await refusalOf(
      h
        .credentials()
        .createCredential({ kind: 'API_TOKEN', name: 'key', secret }),
    ),
    refused(
      'credential_storage_unavailable',
      'The host cannot store credential secrets.',
      Code.Unavailable,
    ),
  );
  assert.deepEqual(
    await refusalOf(
      h.credentials().updateCredential({ credentialId, name: 'x' }),
    ),
    internal,
  );
});

void test('R-cred/P1: DeleteCredential deletes by id, and answers referenced and missing as the route does', async (t) => {
  const referenced = credentialId;
  const missing = credentialId.replace('1601', '1603');
  const deleted = credentialId.replace('1601', '1602');
  const h = await served(t, {
    secrets: {
      delete: ({ id }: { id: string }) =>
        id === referenced
          ? 'referenced'
          : id === missing
            ? 'missing'
            : 'deleted',
    },
  });

  assert.deepEqual(
    toJson(
      DeleteCredentialResponseSchema,
      await h.credentials().deleteCredential({ credentialId: deleted }),
    ),
    {},
  );
  assert.deepEqual(
    await refusalOf(
      h.credentials().deleteCredential({ credentialId: referenced }),
    ),
    refused(
      'credential_referenced',
      'The credential cannot perform this operation.',
      Code.FailedPrecondition,
    ),
  );
  assert.deepEqual(
    await refusalOf(
      h.credentials().deleteCredential({ credentialId: missing }),
    ),
    refused(
      'credential_not_found',
      'The credential was not found.',
      Code.NotFound,
    ),
  );
  assert.deepEqual(requestsOf(h, 'secrets.delete')[0], {
    credentialRef: { id: deleted },
  });
});

// R-prov --------------------------------------------------------------------

const models = (
  catalog: (input: unknown) => unknown = () => ({ status: 'absent' }),
) => ({
  kinds: () => providerKinds,
  kind: (id: string) => providerKind(id),
  catalog,
});

void test('R-prov: ListKinds answers the provider kinds models/v1 lists', async (t) => {
  const h = await served(t, { models: models() });

  assertMessage(ListKindsResponseSchema, await h.providers().listKinds({}), {
    kinds: providerKinds,
  });
});

void test('R-prov: ListModels reads the kind, then the catalog of the normalised draft', async (t) => {
  const h = await served(t, {
    models: models(() => ({ status: 'read', models: [catalogEntry] })),
  });
  const response = await h.providers().listModels({
    kind: '  openrouter ',
    configuration: providerConfiguration,
  });

  assertMessage(ListModelsResponseSchema, response, { models: [catalogEntry] });
  assert.deepEqual(requestsOf(h, 'models.kind'), [{ id: 'openrouter' }]);
  assert.deepEqual(requestsOf(h, 'models.catalog'), [
    { kind: 'openrouter', configuration: providerConfiguration },
  ]);
});

void test('R-prov/P1: an unknown kind or an unaccepted field is invalid_provider, and no catalog is read', async (t) => {
  const h = await served(t, {
    models: {
      ...models(),
      kind: (id: string) => {
        if (id === 'refused') throw new ContractError('unknown_kind', 'No.');

        return providerKind(id);
      },
    },
  });

  const requests: readonly {
    readonly kind: string;
    readonly configuration: { readonly [key: string]: string };
  }[] = [
    { kind: 'nothing', configuration: {} },
    { kind: 'refused', configuration: {} },
    { kind: 'openrouter', configuration: { token: 'not-a-credential' } },
    { kind: 'openrouter', configuration: {} },
    { kind: 'openrouter', configuration: { token: '  ' } },
    {
      kind: 'openrouter',
      configuration: { ...providerConfiguration, modelsUrl: 'ftp://catalog' },
    },
    {
      kind: 'openrouter',
      configuration: { ...providerConfiguration, unknown: 'x' },
    },
  ];

  for (const request of requests) {
    assert.deepEqual(
      await refusalOf(h.providers().listModels(request)),
      refused(
        'invalid_provider',
        'The provider values are invalid.',
        Code.InvalidArgument,
      ),
      JSON.stringify(request),
    );
  }
  assert.deepEqual(requestsOf(h, 'models.catalog'), []);
});

void test('R-prov/P1: a catalog not read is model_catalog_unreadable UNAVAILABLE', async (t) => {
  for (const status of ['failed', 'absent']) {
    const h = await served(t, { models: models(() => ({ status })) });

    assert.deepEqual(
      await refusalOf(
        h.providers().listModels({
          kind: 'openrouter',
          configuration: { token: providerConfiguration.token },
        }),
      ),
      refused(
        'model_catalog_unreadable',
        'The provider model catalog could not be read.',
        Code.Unavailable,
      ),
      status,
    );
  }
});

// R-host --------------------------------------------------------------------

void test('R-host: ListTools answers the tools/v1 catalog entries as {name, description, settings}', async (t) => {
  const h = await served(t, {
    tools: {
      list: () =>
        toolEntries.map((tool) => ({
          bundleId: 'files',
          alwaysAvailable: false,
          tool,
        })),
    },
  });

  assertMessage(ListToolsResponseSchema, await h.hostApi().listTools({}), {
    tools: toolEntries,
  });
  assert.deepEqual(requestsOf(h, 'tools.catalog'), [{}]);
});

void test('R-host: ListResources answers the host reading; without resources/v1 it is unavailable', async (t) => {
  const h = await served(t, { resources: { host: () => reading } });

  assertMessage(
    ListResourcesResponseSchema,
    await h.hostApi().listResources({}),
    reading,
  );

  const absent = await served(t);
  const refusal = await refusalOf(absent.hostApi().listResources({}));

  assert.equal(refusal.reason, 'unavailable');
  assert.equal(refusal.code, Code.Unavailable);
});

const vmFakes: Fakes = {
  sandbox: {
    machines: () => vms,
    machine: (id: string) => vms.find((vm) => vm.id === id),
  },
  runtime: {
    vmSsh: (id: string) =>
      id === 'vm-1' ? { projectId: credentialId, ssh: access } : undefined,
  },
};

void test('R-host: ListVms answers every running VM', async (t) => {
  const h = await served(t, vmFakes);

  assertMessage(ListVmsResponseSchema, await h.hostApi().listVms({}), { vms });
});

void test('R-host/P1: GetVmSsh answers ready access, and a missing or idle VM as the route does', async (t) => {
  const h = await served(t, vmFakes);

  assertMessage(
    GetVmSshResponseSchema,
    await h.hostApi().getVmSsh({ vmId: 'vm-1' }),
    { vm: vms[0], projectId: credentialId, ssh: access },
  );
  assert.deepEqual(requestsOf(h, 'sandbox.machine')[0], { id: 'vm-1' });
  assert.deepEqual(requestsOf(h, 'runtime.vmSsh')[0], { vmId: 'vm-1' });
  assert.deepEqual(
    await refusalOf(h.hostApi().getVmSsh({ vmId: 'vm-2' })),
    refused(
      'vm_ssh_unavailable',
      'SSH is unavailable for this VM.',
      Code.FailedPrecondition,
    ),
  );
  assert.deepEqual(
    await refusalOf(h.hostApi().getVmSsh({ vmId: 'missing' })),
    refused('vm_not_found', 'The VM was not found.', Code.NotFound),
  );
});

// R-term --------------------------------------------------------------------

const terminalFakes: Fakes = {
  terminal: {
    snapshot: (id: string) =>
      id === terminal.id ? terminalSnapshot : undefined,
    input: (id: string) => id === terminal.id,
    resize: (id: string) => id === terminal.id,
    stop: () => false,
  },
};

void test('R-term: GetTerminal passes `after` and answers {terminalSnapshot}; a missing one is terminal_missing', async (t) => {
  const h = await served(t, terminalFakes);

  assertMessage(
    GetTerminalResponseSchema,
    await h.terminals().getTerminal({ terminalId: 'terminal-1', after: 1 }),
    { terminalSnapshot },
  );
  assert.deepEqual(requestsOf(h, 'terminal.snapshot'), [
    { terminalId: 'terminal-1', after: 1 },
  ]);
  assert.deepEqual(
    await refusalOf(h.terminals().getTerminal({ terminalId: 'gone' })),
    refused('terminal_missing', 'Terminal no longer exists.', Code.NotFound),
  );
});

void test('R-term: SendInput and Resize answer {}; false from terminal/v1 is terminal_missing', async (t) => {
  const h = await served(t, terminalFakes);

  await h.terminals().sendInput({ terminalId: 'terminal-1', data: 'ls\n' });
  await h.terminals().resize({ terminalId: 'terminal-1', cols: 100, rows: 40 });
  assert.deepEqual(requestsOf(h, 'terminal.input'), [
    { terminalId: 'terminal-1', data: 'ls\n' },
  ]);
  assert.deepEqual(requestsOf(h, 'terminal.resize'), [
    { terminalId: 'terminal-1', cols: 100, rows: 40 },
  ]);

  const missing = refused(
    'terminal_missing',
    'Terminal no longer exists.',
    Code.NotFound,
  );

  assert.deepEqual(
    await refusalOf(h.terminals().sendInput({ terminalId: 'gone', data: 'x' })),
    missing,
  );
  assert.deepEqual(
    await refusalOf(
      h.terminals().resize({ terminalId: 'gone', cols: 1, rows: 1 }),
    ),
    missing,
  );
});

void test('R-term: DeleteTerminal stops the session and answers {} whatever terminal/v1 held', async (t) => {
  const h = await served(t, terminalFakes);

  await h.terminals().deleteTerminal({ terminalId: 'terminal-1' });
  assert.deepEqual(requestsOf(h, 'terminal.stop'), [
    { terminalId: 'terminal-1' },
  ]);
});

// R-status ------------------------------------------------------------------

void test('R-status: Watch sends one ready item and stays open until the client cancels', async (t) => {
  const h = await served(t);
  const controller = new AbortController();
  const stream = h
    .status()
    .watch({}, { signal: controller.signal })
    [Symbol.asyncIterator]();
  const ready = await stream.next();

  assert.ok(ready.done !== true, 'one ready item');
  assertMessage(WatchResponseSchema, ready.value, { ready: {} });

  const next = stream.next();
  const raced = await Promise.race([
    next.then(
      () => 'item' as const,
      () => 'ended' as const,
    ),
    sleep(50).then(() => 'open' as const),
  ]);

  assert.equal(raced, 'open');
  controller.abort();
  assert.equal((await refusalOf(next)).code, Code.Canceled);
});

// R-deadline ----------------------------------------------------------------

void test('R-deadline: no outgoing call carries a deadline the caller did not set', async (t) => {
  const h = await served(t, everyFake);

  await h.config().getConfig({});
  await h.config().putConfig({ configuration: struct(configuration) });
  await h
    .credentials()
    .createCredential({ kind: 'API_TOKEN', name: 'key', secret });
  await h.providers().listModels({
    kind: 'openrouter',
    configuration: providerConfiguration,
  });
  await h.hostApi().getVmSsh({ vmId: 'vm-1' });
  await h.terminals().getTerminal({ terminalId: 'terminal-1' });

  assert.ok(h.calls.length > 0);
  for (const call of h.calls) assert.equal(call.deadline, 0, call.method);
});

void test("R-deadline: an outgoing call inherits the caller's deadline", async (t) => {
  const h = await served(t, everyFake);

  await h.config().getConfig({}, { timeoutMs: 30_000 });
  await h.hostApi().getVmSsh({ vmId: 'vm-1' }, { timeoutMs: 30_000 });

  assert.ok(h.calls.length > 0);
  for (const call of h.calls) assert.ok(call.deadline > 0, call.method);
});

// M1/M2 in process ------------------------------------------------------------

void test('M1: a request breaking a rule of each field answers INVALID_ARGUMENT with the table reason, before any call', async (t) => {
  const h = await served(t, everyFake);
  const credential = (reason: string) =>
    refused(
      reason,
      reason === 'invalid_credential_id'
        ? 'The credential ID is invalid.'
        : 'The credential does not match its kind.',
      Code.InvalidArgument,
    );
  const cases: readonly (readonly [string, () => Promise<unknown>, Refusal])[] =
    [
      [
        'CreateCredential kind',
        () =>
          h
            .credentials()
            .createCredential({ kind: 'api_token', name: 'key', secret }),
        credential('invalid_credential'),
      ],
      [
        'CreateCredential name',
        () =>
          h
            .credentials()
            .createCredential({ kind: 'API_TOKEN', name: '', secret }),
        credential('invalid_credential'),
      ],
      [
        'CreateCredential email',
        () =>
          h.credentials().createCredential({
            kind: 'GIT',
            name: 'github',
            username: 'octocat',
            email: 'nope',
          }),
        credential('invalid_credential'),
      ],
      [
        'CreateCredential secret line break',
        () =>
          h.credentials().createCredential({
            kind: 'API_TOKEN',
            name: 'key',
            secret: 'two\nlines',
          }),
        credential('invalid_credential'),
      ],
      [
        'CreateCredential empty secret',
        () =>
          h
            .credentials()
            .createCredential({ kind: 'API_TOKEN', name: 'key', secret: '' }),
        credential('invalid_credential'),
      ],
      [
        'UpdateCredential id',
        () =>
          h
            .credentials()
            .updateCredential({ credentialId: 'not-an-id', name: 'x' }),
        credential('invalid_credential_id'),
      ],
      [
        'UpdateCredential email',
        () => h.credentials().updateCredential({ credentialId, email: 'nope' }),
        credential('invalid_credential'),
      ],
      [
        'DeleteCredential id',
        () => h.credentials().deleteCredential({ credentialId: 'not-an-id' }),
        credential('invalid_credential_id'),
      ],
      [
        'ListModels kind',
        () => h.providers().listModels({ kind: '', configuration: {} }),
        refused(
          'invalid_provider',
          'The provider values are invalid.',
          Code.InvalidArgument,
        ),
      ],
      [
        'GetTerminal negative after',
        () =>
          h.terminals().getTerminal({ terminalId: 'terminal-1', after: -1 }),
        refused(
          'invalid_cursor',
          'Invalid output cursor.',
          Code.InvalidArgument,
        ),
      ],
      [
        'GetTerminal fractional after',
        () =>
          h.terminals().getTerminal({ terminalId: 'terminal-1', after: 1.5 }),
        refused(
          'invalid_cursor',
          'Invalid output cursor.',
          Code.InvalidArgument,
        ),
      ],
      [
        'SendInput data',
        () =>
          h
            .terminals()
            .sendInput({ terminalId: 'terminal-1', data: 'x'.repeat(65_537) }),
        refused(
          'invalid_input',
          'Invalid terminal input.',
          Code.InvalidArgument,
        ),
      ],
      [
        'Resize cols',
        () =>
          h.terminals().resize({ terminalId: 'terminal-1', cols: 0, rows: 1 }),
        refused(
          'invalid_size',
          'Invalid terminal dimensions.',
          Code.InvalidArgument,
        ),
      ],
      [
        'Resize rows',
        () =>
          h
            .terminals()
            .resize({ terminalId: 'terminal-1', cols: 1, rows: 1001 }),
        refused(
          'invalid_size',
          'Invalid terminal dimensions.',
          Code.InvalidArgument,
        ),
      ],
    ];

  for (const [name, call, expected] of cases) {
    assert.deepEqual(await refusalOf(call()), expected, name);
  }
  assert.deepEqual(h.calls, []);
});

void test("M1: PutConfig without its configuration answers invalid_config with protovalidate's message", async (t) => {
  const h = await served(t, everyFake);
  const refusal = await refusalOf(h.config().putConfig({}));

  assert.equal(refusal.reason, 'invalid_config');
  assert.equal(refusal.code, Code.InvalidArgument);
  assert.ok(refusal.message.length > 0);
  assert.deepEqual(h.calls, []);
});

void test('M2: a request breaking the path field and a body rule answers the path reason', async (t) => {
  const h = await served(t, everyFake);

  assert.deepEqual(
    await refusalOf(
      h.credentials().updateCredential({
        credentialId: 'not-an-id',
        kind: 'lower',
        email: 'nope',
      }),
    ),
    refused(
      'invalid_credential_id',
      'The credential ID is invalid.',
      Code.InvalidArgument,
    ),
  );
});
