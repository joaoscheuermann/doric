// `transport`'s host part as a process (S60c, contract s60 §2.10): the small
// `doric.api.*` services; S60d adds `projects` and `threads`.

import type { DescMessage, MessageShape } from '@bufbuild/protobuf';
import type { ServiceImpl } from '@connectrpc/connect';
import { ContractError, callOf } from 'bundle/contracts';
import {
  createHookHandlers,
  type HookHandlers,
  type HostContext,
  type InvalidInputAnswer,
  onHostStart,
} from 'bundle/host';
import { encode } from 'runtime/contracts';

import {
  ConfigService,
  GetConfigRequestSchema,
  GetConfigResponseSchema,
  PutConfigResponseSchema,
} from '../../contracts/gen/doric/api/config/v1/config_pb.js';
import {
  CreateCredentialRequestSchema,
  CreateCredentialResponseSchema,
  CredentialsService,
  DeleteCredentialRequestSchema,
  DeleteCredentialResponseSchema,
  ListCredentialsRequestSchema,
  ListCredentialsResponseSchema,
  UpdateCredentialRequestSchema,
  UpdateCredentialResponseSchema,
} from '../../contracts/gen/doric/api/credentials/v1/credentials_pb.js';
import {
  GetVmSshRequestSchema,
  GetVmSshResponseSchema,
  HostService,
  ListResourcesRequestSchema,
  ListResourcesResponseSchema,
  ListToolsRequestSchema,
  ListToolsResponseSchema,
  ListVmsRequestSchema,
  ListVmsResponseSchema,
} from '../../contracts/gen/doric/api/host/v1/host_pb.js';
import { ProjectsService } from '../../contracts/gen/doric/api/projects/v1/projects_pb.js';
import {
  ListKindsRequestSchema,
  ListKindsResponseSchema,
  ListModelsRequestSchema,
  ListModelsResponseSchema,
  ProvidersService,
} from '../../contracts/gen/doric/api/providers/v1/providers_pb.js';
import { StatusService } from '../../contracts/gen/doric/api/status/v1/status_pb.js';
import {
  DeleteTerminalRequestSchema,
  DeleteTerminalResponseSchema,
  GetTerminalRequestSchema,
  GetTerminalResponseSchema,
  ResizeRequestSchema,
  ResizeResponseSchema,
  SendInputRequestSchema,
  SendInputResponseSchema,
  TerminalsService,
} from '../../contracts/gen/doric/api/terminals/v1/terminals_pb.js';
import { ThreadsService } from '../../contracts/gen/doric/api/threads/v1/threads_pb.js';
import {
  type ApiAnswer,
  answerValue,
  apiFailure,
  type RouteInput,
  routeInputOf,
} from '../api/answer.js';
import { configOperations } from '../api/operations/config.js';
import { credentialOperations } from '../api/operations/credentials.js';
import { hostOperations } from '../api/operations/host.js';
import { providerOperations } from '../api/operations/providers.js';
import { terminalOperations } from '../api/operations/terminals.js';
import type { TransportPorts } from '../api/ports.js';
import { invalidApiInput } from '../api/violations.js';
import { routedTransportPorts } from './routed.js';

export interface TransportHost {
  /**
   * The services. Each method answers `unavailable` "transport is not active." before `activate` resolved, if it
   * rejected, and after `deactivate`; then runs §3's operation with `routeInputOf(request, <params>)` and answers the
   * response message built by `encode` from the operation's value (wrapped as the proto names it: `{project}`,
   * `{threadPage}`, `{doricConfiguration}`, `{result: {case: 'value'|'pending', …}}`, …), or ends with `apiError` /
   * `apiFailure` (D3). Streams (`ReadFile`, three `Watch`) end on `callOf(context).signal`.
   */
  readonly config: ServiceImpl<typeof ConfigService>;
  readonly credentials: ServiceImpl<typeof CredentialsService>;
  readonly providers: ServiceImpl<typeof ProvidersService>;
  readonly host: ServiceImpl<typeof HostService>;
  readonly terminals: ServiceImpl<typeof TerminalsService>;
  readonly status: ServiceImpl<typeof StatusService>;
  /** The hook table `main.ts` serves as `HookHandlerService` (the start step, Q5). */
  readonly hooks: HookHandlers;
  /** `invalidApiInput` (2.7). */
  readonly invalidInput: InvalidInputAnswer;
  /**
   * 1. `routedTransportPorts(context.services)`; 2. `onHostStart(hooks, context, step)` with the step of Q5 (a
   * `registration_conflict` or `unavailable` of `hooks/v1` rejects `activate`); 3. the services answer. Makes no other
   * call and starts no background work.
   */
  activate(
    context: Pick<HostContext, 'services' | 'registrations'>,
  ): Promise<void>;
  /** Services answer `unavailable`; open streams end with it. Resolves once done; never rejects. */
  deactivate(): Promise<void>;
}

/** The services Q5's start step names: the eight `doric.api.*` services. */
const API_SERVICES = [
  ConfigService,
  CredentialsService,
  ProvidersService,
  HostService,
  ProjectsService,
  ThreadsService,
  TerminalsService,
  StatusService,
].map(({ typeName }) => typeName);

type Op<V> = (input: RouteInput) => Promise<ApiAnswer<V>>;

/** The route bodies over `ports`. */
const operationsOf = (ports: TransportPorts) => ({
  config: configOperations(ports),
  credentials: credentialOperations(ports),
  providers: providerOperations(ports),
  host: hostOperations(ports),
  terminals: terminalOperations(ports),
});

type Operations = ReturnType<typeof operationsOf>;

const notActive = (): ContractError =>
  new ContractError('unavailable', 'transport is not active.');

const same = (value: unknown): unknown => value;
const empty = (): unknown => ({});

/** Builds the part with no I/O; never throws. */
export const createTransportHost = (): TransportHost => {
  const hooks = createHookHandlers();
  let operations: Operations | undefined;
  /** Wakes the open streams when the part stops answering. */
  const stopping = new Set<() => void>();

  const active = (): Operations => {
    if (operations === undefined) throw notActive();

    return operations;
  };

  /**
   * One unary RPC: `select`'s operation on `input`, its value wrapped by `wrap` and encoded as `schema`; a refusal
   * ends with `apiError`, anything unexpected with `apiFailure`.
   */
  const unary = async <V, D extends DescMessage>(
    select: (current: Operations) => Op<V>,
    input: RouteInput,
    schema: D,
    wrap: (value: V) => unknown,
  ): Promise<MessageShape<D>> => {
    const operation = select(active());
    let answer: ApiAnswer<V>;

    try {
      answer = await operation(input);
    } catch (error) {
      throw apiFailure(error);
    }

    const value = answerValue(answer);

    try {
      return encode(schema, wrap(value));
    } catch (error) {
      throw apiFailure(error);
    }
  };

  /** Resolves once `signal` aborts or the part stops answering. */
  const settled = (signal: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
      if (signal.aborted || operations === undefined) {
        resolve();
        return;
      }

      const wake = () => {
        stopping.delete(wake);
        signal.removeEventListener('abort', wake);
        resolve();
      };

      stopping.add(wake);
      signal.addEventListener('abort', wake, { once: true });
    });

  return {
    config: {
      getConfig: (request) =>
        unary(
          ({ config }) => config.current,
          routeInputOf(GetConfigRequestSchema, request, {}),
          GetConfigResponseSchema,
          (value) => ({ doricConfiguration: value }),
        ),
      putConfig: (request) =>
        unary(
          ({ config }) => config.replace,
          { params: {}, query: {}, body: request.configuration },
          PutConfigResponseSchema,
          (value) => ({ doricConfiguration: value }),
        ),
    },
    credentials: {
      listCredentials: (request) =>
        unary(
          ({ credentials }) => credentials.list,
          routeInputOf(ListCredentialsRequestSchema, request, {}),
          ListCredentialsResponseSchema,
          (value) => ({ credentials: value }),
        ),
      createCredential: (request) =>
        unary(
          ({ credentials }) => credentials.create,
          routeInputOf(CreateCredentialRequestSchema, request, {}),
          CreateCredentialResponseSchema,
          (value) => ({ credentialDescription: value }),
        ),
      updateCredential: (request) =>
        unary(
          ({ credentials }) => credentials.update,
          routeInputOf(UpdateCredentialRequestSchema, request, {
            credentialId: 'id',
          }),
          UpdateCredentialResponseSchema,
          (value) => ({ credentialDescription: value }),
        ),
      deleteCredential: (request) =>
        unary(
          ({ credentials }) => credentials.remove,
          routeInputOf(DeleteCredentialRequestSchema, request, {
            credentialId: 'id',
          }),
          DeleteCredentialResponseSchema,
          empty,
        ),
    },
    providers: {
      listKinds: (request) =>
        unary(
          ({ providers }) => providers.kinds,
          routeInputOf(ListKindsRequestSchema, request, {}),
          ListKindsResponseSchema,
          same,
        ),
      listModels: (request) =>
        unary(
          ({ providers }) => providers.models,
          routeInputOf(ListModelsRequestSchema, request, {}),
          ListModelsResponseSchema,
          same,
        ),
    },
    host: {
      listTools: (request) =>
        unary(
          ({ host }) => host.tools,
          routeInputOf(ListToolsRequestSchema, request, {}),
          ListToolsResponseSchema,
          same,
        ),
      listResources: (request) =>
        unary(
          ({ host }) => host.resources,
          routeInputOf(ListResourcesRequestSchema, request, {}),
          ListResourcesResponseSchema,
          same,
        ),
      listVms: (request) =>
        unary(
          ({ host }) => host.vms,
          routeInputOf(ListVmsRequestSchema, request, {}),
          ListVmsResponseSchema,
          (value) => ({ vms: value }),
        ),
      getVmSsh: (request) =>
        unary(
          ({ host }) => host.vmSsh,
          routeInputOf(GetVmSshRequestSchema, request, { vmId: 'id' }),
          GetVmSshResponseSchema,
          same,
        ),
    },
    terminals: {
      getTerminal: (request) =>
        unary(
          ({ terminals }) => terminals.snapshot,
          routeInputOf(GetTerminalRequestSchema, request, { terminalId: 'id' }),
          GetTerminalResponseSchema,
          (value) => ({ terminalSnapshot: value }),
        ),
      sendInput: (request) =>
        unary(
          ({ terminals }) => terminals.input,
          routeInputOf(SendInputRequestSchema, request, { terminalId: 'id' }),
          SendInputResponseSchema,
          empty,
        ),
      resize: (request) =>
        unary(
          ({ terminals }) => terminals.resize,
          routeInputOf(ResizeRequestSchema, request, { terminalId: 'id' }),
          ResizeResponseSchema,
          empty,
        ),
      deleteTerminal: (request) =>
        unary(
          ({ terminals }) => terminals.stop,
          routeInputOf(DeleteTerminalRequestSchema, request, {
            terminalId: 'id',
          }),
          DeleteTerminalResponseSchema,
          empty,
        ),
    },
    status: {
      async *watch(_request, context) {
        active();
        yield { event: { case: 'ready', value: {} } };

        const { signal } = callOf(context);

        await settled(signal);
        if (!signal.aborted) throw notActive();
      },
    },
    hooks,
    invalidInput: invalidApiInput,
    activate: async (context) => {
      const ports = routedTransportPorts(context.services);

      await onHostStart(hooks, context, async (startup) => {
        await startup.log('info', 'Network interfaces configured', {
          apiServices: API_SERVICES,
        });
      });
      operations = operationsOf(ports);
    },
    deactivate: () => {
      operations = undefined;
      for (const wake of [...stopping]) wake();

      return Promise.resolve();
    },
  };
};
