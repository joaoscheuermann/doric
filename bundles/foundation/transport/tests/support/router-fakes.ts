// The router fakes of the generated services the S60c routes call, driven by
// the same domain fakes `./host.ts` serves the kernel with: each fake decodes
// its request to today's arguments (`decode`), records it (its JSON, scope
// and deadline), calls the domain method and answers its value `encode`d into
// the response message. A domain method that throws fails the call with its
// error (a `ContractError` keeps its code); a missing one fails `internal`.

import {
  type DescMessage,
  type MessageShape,
  toJson,
} from '@bufbuild/protobuf';
import type { HandlerContext } from '@connectrpc/connect';
import {
  KindRequestSchema,
  KindResponseSchema,
  KindsResponseSchema as ModelKindsResponseSchema,
  CatalogRequestSchema as ModelsCatalogRequestSchema,
  CatalogResponseSchema as ModelsCatalogResponseSchema,
  ModelsService,
} from 'bundle/contracts/gen/doric/models/v1/models_pb.js';
import {
  CreateRequestSchema,
  CreateResponseSchema,
  KindsResponseSchema as CredentialKindsResponseSchema,
  DeleteRequestSchema,
  DeleteResponseSchema,
  ListResponseSchema,
  SecretsService,
  UpdateRequestSchema,
  UpdateResponseSchema,
} from 'bundle/contracts/gen/doric/secrets/v1/secrets_pb.js';
import {
  CatalogResponseSchema as ToolsCatalogResponseSchema,
  ToolsService,
} from 'bundle/contracts/gen/doric/tools/v1/tools_pb.js';
import type { ServiceEntry } from 'bundle/host';
import {
  CurrentResponseSchema,
  HostConfigService,
  ReplaceRequestSchema,
  ReplaceResponseSchema,
} from 'host-config/contracts/gen/doric/host_config/v1/host_config_pb.js';
import {
  HostResponseSchema,
  ResourcesService,
} from 'resources/contracts/gen/doric/resources/v1/resources_pb.js';
import { decode, encode } from 'runtime/contracts';
import {
  RuntimeService,
  VmSshRequestSchema,
  VmSshResponseSchema,
} from 'runtime/contracts/gen/doric/runtime/v2/runtime_pb.js';
import {
  MachineRequestSchema,
  MachineResponseSchema,
  MachinesResponseSchema,
  SandboxService,
} from 'runtime/contracts/gen/doric/sandbox/v1/sandbox_pb.js';
import {
  InputRequestSchema,
  InputResponseSchema,
  ResizeRequestSchema,
  ResizeResponseSchema,
  SnapshotRequestSchema,
  SnapshotResponseSchema,
  StopRequestSchema,
  StopResponseSchema,
  TerminalService,
} from 'terminal/contracts/gen/doric/terminal/v1/terminal_pb.js';

import type { Fake, Fakes } from './host.js';
import { fakeOf, type Recorder } from './router.js';
import { registeredKinds } from './router-fixtures.js';

type Json = { readonly [key: string]: unknown };

/** One unary fake method: request → today's args → domain value → response. */
const unary =
  <O extends DescMessage>(
    record: Recorder,
    name: string,
    fake: Fake,
    method: string,
    input: DescMessage | undefined,
    args: (request: Json) => readonly unknown[],
    output: O,
    wrap: (value: unknown) => unknown,
  ) =>
  async (
    request: unknown,
    context: HandlerContext,
  ): Promise<MessageShape<O>> => {
    const message = request as MessageShape<DescMessage>;

    record(
      `${name}.${method}`,
      input === undefined ? {} : toJson(input, message),
      context,
    );

    const domain = fake[method];

    if (domain === undefined) throw new Error(`Unexpected ${name} ${method}.`);

    const json = (input === undefined ? {} : decode(input, message)) as Json;

    return encode(output, wrap(await domain(...args(json))));
  };

const none = () => [] as const;

/**
 * The generated-service fakes of `fakes` (the kinds `secrets/v1` answers
 * default to the built-in ones and GIT, as `./host.ts` does). Only the
 * services `fakes` names are served, plus `secrets/v1` always.
 */
export const routerFakes = (
  record: Recorder,
  fakes: Fakes = {},
): readonly ServiceEntry[] => {
  const entries: ServiceEntry[] = [];
  const secrets: Fake = { kinds: () => registeredKinds, ...fakes.secrets };

  entries.push(
    fakeOf(SecretsService, {
      list: unary(
        record,
        'secrets',
        secrets,
        'list',
        undefined,
        none,
        ListResponseSchema,
        (value) => ({ credentials: value }),
      ),
      kinds: unary(
        record,
        'secrets',
        secrets,
        'kinds',
        undefined,
        none,
        CredentialKindsResponseSchema,
        (value) => ({ kinds: value }),
      ),
      create: unary(
        record,
        'secrets',
        secrets,
        'create',
        CreateRequestSchema,
        (request) => [request],
        CreateResponseSchema,
        (value) => ({ credentialDescription: value }),
      ),
      update: unary(
        record,
        'secrets',
        secrets,
        'update',
        UpdateRequestSchema,
        (request) => [request.ref, request.update],
        UpdateResponseSchema,
        (value) => ({ credentialDescription: value }),
      ),
      delete: unary(
        record,
        'secrets',
        secrets,
        'delete',
        DeleteRequestSchema,
        (request) => [request.credentialRef],
        DeleteResponseSchema,
        (value) => ({ result: value }),
      ),
    }),
  );

  if (fakes.configuration !== undefined) {
    const fake = fakes.configuration;

    entries.push(
      fakeOf(HostConfigService, {
        current: unary(
          record,
          'hostConfig',
          fake,
          'current',
          undefined,
          none,
          CurrentResponseSchema,
          (value) => ({ doricConfiguration: value }),
        ),
        replace: unary(
          record,
          'hostConfig',
          fake,
          'replace',
          ReplaceRequestSchema,
          (request) => [request.input],
          ReplaceResponseSchema,
          (value) => value,
        ),
      }),
    );
  }

  if (fakes.models !== undefined) {
    const fake = fakes.models;

    entries.push(
      fakeOf(ModelsService, {
        kinds: unary(
          record,
          'models',
          fake,
          'kinds',
          undefined,
          none,
          ModelKindsResponseSchema,
          (value) => ({ kinds: value }),
        ),
        kind: unary(
          record,
          'models',
          fake,
          'kind',
          KindRequestSchema,
          (request) => [request.id],
          KindResponseSchema,
          (value) => ({ modelKindDescriptor: value }),
        ),
        catalog: unary(
          record,
          'models',
          fake,
          'catalog',
          ModelsCatalogRequestSchema,
          (request) => [request],
          ModelsCatalogResponseSchema,
          (value) => ({ catalogResult: value }),
        ),
      }),
    );
  }

  if (fakes.tools !== undefined) {
    const fake = fakes.tools;

    entries.push(
      fakeOf(ToolsService, {
        catalog: unary(
          record,
          'tools',
          {
            catalog:
              fake.list ??
              (() => {
                throw new Error('Unexpected tools list.');
              }),
          },
          'catalog',
          undefined,
          none,
          ToolsCatalogResponseSchema,
          (value) => ({
            entries: (value as readonly { readonly tool: unknown }[]).map(
              ({ tool }) => tool,
            ),
          }),
        ),
      }),
    );
  }

  if (fakes.resources !== undefined) {
    const fake = fakes.resources;

    entries.push(
      fakeOf(ResourcesService, {
        host: unary(
          record,
          'resources',
          fake,
          'host',
          undefined,
          none,
          HostResponseSchema,
          (value) => value,
        ),
      }),
    );
  }

  if (fakes.sandbox !== undefined) {
    const fake = fakes.sandbox;

    entries.push(
      fakeOf(SandboxService, {
        machines: unary(
          record,
          'sandbox',
          fake,
          'machines',
          undefined,
          none,
          MachinesResponseSchema,
          (value) => ({ machines: value }),
        ),
        machine: unary(
          record,
          'sandbox',
          fake,
          'machine',
          MachineRequestSchema,
          (request) => [request.id],
          MachineResponseSchema,
          (value) => ({ runningMachine: value }),
        ),
      }),
    );
  }

  if (fakes.runtime !== undefined) {
    const fake = fakes.runtime;

    entries.push(
      fakeOf(RuntimeService, {
        vmSsh: unary(
          record,
          'runtime',
          fake,
          'vmSsh',
          VmSshRequestSchema,
          (request) => [request.vmId],
          VmSshResponseSchema,
          (value) => ({ vmSsh: value }),
        ),
      }),
    );
  }

  if (fakes.terminal !== undefined) {
    const fake = fakes.terminal;

    entries.push(
      fakeOf(TerminalService, {
        snapshot: unary(
          record,
          'terminal',
          fake,
          'snapshot',
          SnapshotRequestSchema,
          (request) => [request.terminalId, request.after],
          SnapshotResponseSchema,
          (value) => ({ terminalSnapshot: value }),
        ),
        input: unary(
          record,
          'terminal',
          fake,
          'input',
          InputRequestSchema,
          (request) => [request.terminalId, request.data],
          InputResponseSchema,
          (value) => ({ sent: value }),
        ),
        resize: unary(
          record,
          'terminal',
          fake,
          'resize',
          ResizeRequestSchema,
          (request) => [request.terminalId, request.cols, request.rows],
          ResizeResponseSchema,
          (value) => ({ resized: value }),
        ),
        stop: unary(
          record,
          'terminal',
          fake,
          'stop',
          StopRequestSchema,
          (request) => [request.terminalId],
          StopResponseSchema,
          (value) => ({ stopped: value }),
        ),
      }),
    );
  }

  return entries;
};
