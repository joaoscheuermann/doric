// P2 for the S60c services (phase 3, contract s60 §6 P2): for one success
// per RPC, the response of the process equals the kernel route's body under
// the wrapper of §3 (`{doricConfiguration}`, `{credentials}`, `{vms}`,
// `{terminalSnapshot}`, `{}` for a 204, …), with the same domain fakes in the
// kernel world (`./support/host.ts`) and the router world
// (`./support/router-fakes.ts`). Both sides are compared as proto JSON.

import assert from 'node:assert/strict';
import test from 'node:test';

import type { DescMessage, JsonObject, MessageShape } from '@bufbuild/protobuf';
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
import {
  DeleteTerminalResponseSchema,
  GetTerminalResponseSchema,
  ResizeResponseSchema,
  SendInputResponseSchema,
} from '../src/contracts/gen/doric/api/terminals/v1/terminals_pb.js';
import { type Fakes, serve } from './support/host.js';
import type { Harness } from './support/router.js';
import { routerFakes } from './support/router-fakes.js';
import {
  access,
  activated,
  assertMessage,
  catalogEntry,
  configuration,
  credentialId,
  described,
  providerConfiguration,
  reading,
  secret,
  snapshot,
  terminalSnapshot,
  toolEntries,
  vms,
} from './support/router-fixtures.js';

/** The same domain fakes for both worlds. */
const fakes: Fakes = {
  configuration: {
    current: () => snapshot(1),
    replace: () => ({ status: 'replaced', config: snapshot(2) }),
  },
  secrets: {
    list: () => [described],
    create: (input: { name: string }) => ({ ...described, name: input.name }),
    update: (_ref: unknown, input: { name?: string }) => ({
      ...described,
      name: input.name ?? described.name,
    }),
    delete: () => 'deleted',
  },
  models: {
    kinds: () => providerKinds,
    kind: (id: string) => providerKind(id),
    catalog: () => ({ status: 'read', models: [catalogEntry] }),
  },
  tools: {
    list: () =>
      toolEntries.map((tool) => ({
        bundleId: 'files',
        alwaysAvailable: false,
        tool,
      })),
  },
  resources: { host: () => reading },
  sandbox: {
    machines: () => vms,
    machine: (id: string) => vms.find((vm) => vm.id === id),
  },
  runtime: {
    vmSsh: (id: string) =>
      id === 'vm-1' ? { projectId: credentialId, ssh: access } : undefined,
  },
  terminal: {
    snapshot: () => terminalSnapshot,
    input: () => true,
    resize: () => true,
    stop: () => true,
  },
};

interface Case {
  readonly rpc: string;
  /** The kernel route: path, method and JSON body. */
  readonly route: readonly [string, string?, unknown?];
  readonly schema: DescMessage;
  readonly call: (h: Harness) => Promise<MessageShape<DescMessage>>;
  /** The route's body as the RPC's response JSON (`undefined` for a 204). */
  readonly wrap: (body: unknown) => unknown;
}

const asIs = (body: unknown) => body;
const empty = () => ({});

const cases: readonly Case[] = [
  {
    rpc: 'GetConfig',
    route: ['/config'],
    schema: GetConfigResponseSchema,
    call: (h) => h.config().getConfig({}),
    wrap: (body) => ({ doricConfiguration: body }),
  },
  {
    rpc: 'PutConfig',
    route: ['/config', 'PUT', configuration],
    schema: PutConfigResponseSchema,
    call: (h) =>
      h.config().putConfig({
        configuration: configuration as JsonObject,
      }),
    wrap: (body) => ({ doricConfiguration: body }),
  },
  {
    rpc: 'ListCredentials',
    route: ['/credentials'],
    schema: ListCredentialsResponseSchema,
    call: (h) => h.credentials().listCredentials({}),
    wrap: (body) => ({ credentials: body }),
  },
  {
    rpc: 'CreateCredential',
    route: [
      '/credentials',
      'POST',
      { kind: 'API_TOKEN', name: ' openrouter ', secret },
    ],
    schema: CreateCredentialResponseSchema,
    call: (h) =>
      h
        .credentials()
        .createCredential({ kind: 'API_TOKEN', name: ' openrouter ', secret }),
    wrap: (body) => ({ credentialDescription: body }),
  },
  {
    rpc: 'UpdateCredential',
    route: [`/credentials/${credentialId}`, 'PATCH', { name: 'renamed' }],
    schema: UpdateCredentialResponseSchema,
    call: (h) =>
      h.credentials().updateCredential({ credentialId, name: 'renamed' }),
    wrap: (body) => ({ credentialDescription: body }),
  },
  {
    rpc: 'DeleteCredential',
    route: [`/credentials/${credentialId}`, 'DELETE'],
    schema: DeleteCredentialResponseSchema,
    call: (h) => h.credentials().deleteCredential({ credentialId }),
    wrap: empty,
  },
  {
    rpc: 'ListKinds',
    route: ['/providers/kinds'],
    schema: ListKindsResponseSchema,
    call: (h) => h.providers().listKinds({}),
    wrap: asIs,
  },
  {
    rpc: 'ListModels',
    route: [
      '/providers/models',
      'POST',
      { kind: 'openrouter', configuration: providerConfiguration },
    ],
    schema: ListModelsResponseSchema,
    call: (h) =>
      h.providers().listModels({
        kind: 'openrouter',
        configuration: providerConfiguration,
      }),
    wrap: asIs,
  },
  {
    rpc: 'ListTools',
    route: ['/tools'],
    schema: ListToolsResponseSchema,
    call: (h) => h.hostApi().listTools({}),
    wrap: asIs,
  },
  {
    rpc: 'ListResources',
    route: ['/resources'],
    schema: ListResourcesResponseSchema,
    call: (h) => h.hostApi().listResources({}),
    wrap: asIs,
  },
  {
    rpc: 'ListVms',
    route: ['/vms'],
    schema: ListVmsResponseSchema,
    call: (h) => h.hostApi().listVms({}),
    wrap: (body) => ({ vms: body }),
  },
  {
    rpc: 'GetVmSsh',
    route: ['/vms/vm-1/ssh'],
    schema: GetVmSshResponseSchema,
    call: (h) => h.hostApi().getVmSsh({ vmId: 'vm-1' }),
    wrap: asIs,
  },
  {
    rpc: 'GetTerminal',
    route: ['/terminals/terminal-1?after=1'],
    schema: GetTerminalResponseSchema,
    call: (h) =>
      h.terminals().getTerminal({ terminalId: 'terminal-1', after: 1 }),
    wrap: (body) => ({ terminalSnapshot: body }),
  },
  {
    rpc: 'SendInput',
    route: ['/terminals/terminal-1/input', 'POST', { data: 'ls\n' }],
    schema: SendInputResponseSchema,
    call: (h) =>
      h.terminals().sendInput({ terminalId: 'terminal-1', data: 'ls\n' }),
    wrap: empty,
  },
  {
    rpc: 'Resize',
    route: ['/terminals/terminal-1/resize', 'POST', { cols: 100, rows: 40 }],
    schema: ResizeResponseSchema,
    call: (h) =>
      h.terminals().resize({ terminalId: 'terminal-1', cols: 100, rows: 40 }),
    wrap: empty,
  },
  {
    rpc: 'DeleteTerminal',
    route: ['/terminals/terminal-1', 'DELETE'],
    schema: DeleteTerminalResponseSchema,
    call: (h) => h.terminals().deleteTerminal({ terminalId: 'terminal-1' }),
    wrap: empty,
  },
];

for (const { rpc, route, schema, call, wrap } of cases) {
  void test(`P2: ${rpc} answers the route's body under its wrapper`, async (t) => {
    const kernel = await serve(fakes);

    t.after(kernel.close);
    const [path, method, body] = route;
    const response = await kernel.request(path, method, body);
    const text = await response.text();

    assert.ok(response.status < 300, `${rpc}: ${response.status} ${text}`);
    const routeBody: unknown = text === '' ? undefined : JSON.parse(text);

    const h = await activated(t, {
      fakes: (record) => routerFakes(record, fakes),
    });

    assertMessage(schema, await call(h), wrap(routeBody), rpc);
  });
}
