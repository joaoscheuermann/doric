// `TransportPorts` over the router (phase 3, S60c, contract s60 §2.8, D2):
// `routedTransportPorts` makes no call when created; each port the S60c
// services use calls its generated service and answers the kernel value —
// today's JSON as runtime's codec decodes it, `undefined` for an absent
// optional record — and rejects with a `ContractError` (never a
// `ConnectError`), so the operations read refusals by their Doric code.

import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import type { DescMessage } from '@bufbuild/protobuf';
import { ConnectError } from '@connectrpc/connect';
import {
  ContractError,
  callOf,
  deadlineOf,
  isContractError,
} from 'bundle/contracts';
import {
  CatalogResultSchema,
  ModelKindDescriptorSchema,
} from 'bundle/contracts/gen/doric/models/provider/v1/provider_pb.js';
import { CredentialDescriptionSchema } from 'bundle/contracts/gen/doric/secrets/v1/secrets_pb.js';
import { ToolCatalogEntrySchema } from 'bundle/contracts/gen/doric/tools/v1/tools_pb.js';
import { createTestRouter } from 'bundle/testing';
import { DoricConfigurationSchema } from 'host-config/contracts/gen/doric/host_config/v1/host_config_pb.js';
import { providerKind, providerKinds } from 'llms';
import { HostResponseSchema } from 'resources/contracts/gen/doric/resources/v1/resources_pb.js';
import { decode, encode } from 'runtime/contracts';
import { VmSshSchema } from 'runtime/contracts/gen/doric/runtime/v2/runtime_pb.js';
import { RunningMachineSchema } from 'runtime/contracts/gen/doric/sandbox/v1/sandbox_pb.js';
import { TerminalSnapshotSchema } from 'terminal/contracts/gen/doric/terminal/v1/terminal_pb.js';

import type { TransportPorts } from '../src/host/api/ports.js';
import { routedTransportPorts } from '../src/host/process/routed.js';
import { type FakeCall, REQUIRES, type Recorder } from './support/router.js';
import { type Fakes, routerFakes } from './support/router-fakes.js';
import {
  access,
  catalogEntry,
  configuration,
  credentialId,
  described,
  projectId,
  reading,
  snapshot,
  terminalSnapshot,
  toolEntries,
  vms,
} from './support/router-fixtures.js';

/** A value as the kernel sees it after the router: encoded into `schema`, then decoded. */
const viaCodec = (schema: DescMessage, value: unknown): unknown =>
  decode(schema, encode(schema, value));

/** The routed ports over fakes of `fakes`, from a context of the test router. */
const portsOver = async (
  t: TestContext,
  fakes: Fakes = {},
): Promise<{ readonly ports: TransportPorts; readonly calls: FakeCall[] }> => {
  const calls: FakeCall[] = [];
  const record: Recorder = (method, request, context) => {
    const call = callOf(context);

    calls.push({
      method,
      request,
      scope: call.scope,
      deadline: deadlineOf(call),
    });
  };
  const router = createTestRouter({
    requires: REQUIRES,
    instance: { bundleId: 'transport' },
    fakes: routerFakes(record, fakes),
  });

  t.after(() => router.control.stop());
  const context = await router.activate({
    services: [],
    activate: () => undefined,
  });

  return { ports: routedTransportPorts(context.services), calls };
};

/** The error `promise` rejects with, asserting it is a `ContractError`. */
const contractRejection = async (
  promise: Promise<unknown>,
): Promise<ContractError> => {
  try {
    await promise;
  } catch (error) {
    assert.ok(!(error instanceof ConnectError), 'not a ConnectError');
    assert.ok(isContractError(error), `a ContractError: ${error}`);

    return error;
  }

  return assert.fail('the call succeeded');
};

void test('routed: creating the ports, and their scoped factories, makes no call', async (t) => {
  const { ports, calls } = await portsOver(t, {
    configuration: { current: () => snapshot(1) },
    resources: { host: () => reading },
  });

  ports.resources();
  ports.resources({ projectId });
  ports.files({ projectId });
  ports.git({ projectId });
  ports.lease({ projectId });

  assert.deepEqual(calls, []);
});

void test('routed: configuration.current and replace answer the kernel values, replace sending the input as a Value', async (t) => {
  const { ports, calls } = await portsOver(t, {
    configuration: {
      current: () => snapshot(1),
      replace: (input: { providers?: unknown }) =>
        input.providers === undefined
          ? { status: 'invalid', message: 'No providers.' }
          : { status: 'replaced', config: snapshot(2) },
    },
  });

  assert.deepEqual(
    await ports.configuration.current(),
    viaCodec(DoricConfigurationSchema, snapshot(1)),
  );
  assert.deepEqual(await ports.configuration.replace(configuration), {
    status: 'replaced',
    config: viaCodec(DoricConfigurationSchema, snapshot(2)),
  });
  assert.deepEqual(await ports.configuration.replace({}), {
    status: 'invalid',
    message: 'No providers.',
  });
  assert.deepEqual(
    calls.filter(({ method }) => method === 'hostConfig.replace')[0]?.request,
    { input: configuration },
  );
});

void test("routed: secrets list, create, update and delete answer the kernel values and send today's arguments", async (t) => {
  const { ports, calls } = await portsOver(t, {
    secrets: {
      list: () => [described],
      create: () => described,
      update: () => ({ ...described, name: 'renamed' }),
      delete: () => 'referenced',
    },
  });

  assert.deepEqual(await ports.secrets.list(), [
    viaCodec(CredentialDescriptionSchema, described),
  ]);
  assert.deepEqual(
    await ports.secrets.create({ kind: 'API_TOKEN', name: 'key', secret: 'k' }),
    viaCodec(CredentialDescriptionSchema, described),
  );
  assert.deepEqual(
    await ports.secrets.update(
      { id: credentialId },
      { name: 'renamed', username: '' },
    ),
    viaCodec(CredentialDescriptionSchema, { ...described, name: 'renamed' }),
  );
  assert.equal(await ports.secrets.delete({ id: credentialId }), 'referenced');
  assert.deepEqual(
    calls.map(({ method, request }) => [method, request]),
    [
      ['secrets.list', {}],
      ['secrets.create', { kind: 'API_TOKEN', name: 'key', secret: 'k' }],
      [
        'secrets.update',
        {
          ref: { id: credentialId },
          update: { name: 'renamed', username: '' },
        },
      ],
      ['secrets.delete', { credentialRef: { id: credentialId } }],
    ],
  );
});

void test("routed: a callee's refusal rejects with its ContractError code and message, a crash with internal", async (t) => {
  const { ports } = await portsOver(t, {
    secrets: {
      create: () => {
        throw new ContractError('credential_name_taken', 'Taken.');
      },
      update: () => {
        throw new Error('crash');
      },
    },
  });

  const refused = await contractRejection(
    ports.secrets.create({ kind: 'API_TOKEN', name: 'key', secret: 'k' }),
  );

  assert.equal(refused.code, 'credential_name_taken');
  assert.equal(refused.message, 'Taken.');
  assert.equal(
    (
      await contractRejection(
        ports.secrets.update({ id: credentialId }, { name: 'x' }),
      )
    ).code,
    'internal',
  );
});

void test('routed: an absent optional provider rejects with a ContractError unavailable', async (t) => {
  const { ports } = await portsOver(t);

  assert.equal(
    (await contractRejection(ports.resources().host())).code,
    'unavailable',
  );
  assert.equal(
    (await contractRejection(ports.terminal.snapshot('terminal-1', 0))).code,
    'unavailable',
  );
});

void test('routed: models.kinds and kind answer the descriptors; an absent kind or unknown_kind reads as undefined', async (t) => {
  const { ports, calls } = await portsOver(t, {
    models: {
      kinds: () => providerKinds,
      kind: (id: string) => {
        if (id === 'refused') throw new ContractError('unknown_kind', 'No.');

        return providerKind(id);
      },
      catalog: () => ({ status: 'read', models: [catalogEntry] }),
    },
  });

  assert.deepEqual(
    await ports.models.kinds(),
    providerKinds.map((kind) => viaCodec(ModelKindDescriptorSchema, kind)),
  );
  assert.deepEqual(
    await ports.models.kind('openrouter'),
    viaCodec(ModelKindDescriptorSchema, providerKind('openrouter')),
  );
  assert.equal(await ports.models.kind('nothing'), undefined);
  assert.equal(await ports.models.kind('refused'), undefined);
  assert.deepEqual(
    await ports.models.catalog({
      kind: 'openrouter',
      configuration: { token: 't' },
    }),
    viaCodec(CatalogResultSchema, { status: 'read', models: [catalogEntry] }),
  );
  assert.deepEqual(
    calls.filter(({ method }) => method === 'models.catalog')[0]?.request,
    { kind: 'openrouter', configuration: { token: 't' } },
  );
});

void test('routed: tools.list answers the Catalog entries as {tool: entry}', async (t) => {
  const { ports } = await portsOver(t, {
    tools: {
      list: () =>
        toolEntries.map((tool) => ({
          bundleId: 'files',
          alwaysAvailable: false,
          tool,
        })),
    },
  });

  assert.deepEqual(
    await ports.tools.list(),
    toolEntries.map((tool) => ({
      tool: viaCodec(ToolCatalogEntrySchema, tool),
    })),
  );
});

void test('routed: resources().host answers the host reading', async (t) => {
  const { ports } = await portsOver(t, { resources: { host: () => reading } });

  assert.deepEqual(
    await ports.resources().host(),
    viaCodec(HostResponseSchema, reading),
  );
});

void test('routed: sandbox and runtime.vmSsh answer the machines, undefined for an absent one', async (t) => {
  const { ports, calls } = await portsOver(t, {
    sandbox: {
      machines: () => vms,
      machine: (id: string) => vms.find((vm) => vm.id === id),
    },
    runtime: {
      vmSsh: (id: string) =>
        id === 'vm-1' ? { projectId, ssh: access } : undefined,
    },
  });

  assert.deepEqual(
    await ports.sandbox.machines(),
    vms.map((vm) => viaCodec(RunningMachineSchema, vm)),
  );
  assert.deepEqual(
    await ports.sandbox.machine('vm-1'),
    viaCodec(RunningMachineSchema, vms[0]),
  );
  assert.equal(await ports.sandbox.machine('missing'), undefined);
  assert.deepEqual(
    await ports.runtime.vmSsh('vm-1'),
    viaCodec(VmSshSchema, { projectId, ssh: access }),
  );
  assert.equal(await ports.runtime.vmSsh('vm-2'), undefined);
  assert.deepEqual(
    calls.map(({ method, request }) => [method, request]),
    [
      ['sandbox.machines', {}],
      ['sandbox.machine', { id: 'vm-1' }],
      ['sandbox.machine', { id: 'missing' }],
      ['runtime.vmSsh', { vmId: 'vm-1' }],
      ['runtime.vmSsh', { vmId: 'vm-2' }],
    ],
  );
});

void test('routed: terminal snapshot, input, resize and stop answer the outcomes as data', async (t) => {
  const { ports, calls } = await portsOver(t, {
    terminal: {
      snapshot: (id: string) =>
        id === 'terminal-1' ? terminalSnapshot : undefined,
      input: (id: string) => id === 'terminal-1',
      resize: () => false,
      stop: () => true,
    },
  });

  assert.deepEqual(
    await ports.terminal.snapshot('terminal-1', 3),
    viaCodec(TerminalSnapshotSchema, terminalSnapshot),
  );
  assert.equal(await ports.terminal.snapshot('gone', 0), undefined);
  assert.equal(await ports.terminal.input('terminal-1', 'ls\n'), true);
  assert.equal(await ports.terminal.input('gone', 'x'), false);
  assert.equal(await ports.terminal.resize('terminal-1', 80, 24), false);
  assert.equal(await ports.terminal.stop('terminal-1'), true);
  assert.deepEqual(
    calls.map(({ method, request }) => [method, request]),
    [
      ['terminal.snapshot', { terminalId: 'terminal-1', after: 3 }],
      ['terminal.snapshot', { terminalId: 'gone' }],
      ['terminal.input', { terminalId: 'terminal-1', data: 'ls\n' }],
      ['terminal.input', { terminalId: 'gone', data: 'x' }],
      ['terminal.resize', { terminalId: 'terminal-1', cols: 80, rows: 24 }],
      ['terminal.stop', { terminalId: 'terminal-1' }],
    ],
  );
});

void test('routed: a call made outside a handler carries no scope and no deadline', async (t) => {
  const { ports, calls } = await portsOver(t, {
    configuration: { current: () => snapshot(1) },
  });

  await ports.configuration.current();

  assert.deepEqual(
    calls.map(({ scope, deadline }) => ({ scope, deadline })),
    [{ scope: undefined, deadline: 0 }],
  );
});
