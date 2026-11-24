// `transport`'s host part as a process (S60c/S60d, contract s60 §2.10): the
// eight `doric.api.*` services over the route bodies and the routed ports.

import {
  type DescMessage,
  type MessageShape,
  toBinary,
} from '@bufbuild/protobuf';
import type { HandlerContext, ServiceImpl } from '@connectrpc/connect';
import { ContractError, callOf } from 'bundle/contracts';
import {
  createHookHandlers,
  type HookHandlers,
  type HostContext,
  type HostServices,
  type InvalidInputAnswer,
  onHostStart,
} from 'bundle/host';
import { encode } from 'runtime/contracts';
import { ThreadsService as RuntimeThreadsService } from 'runtime/contracts/gen/doric/runtime/threads/v1/threads_pb.js';
import { RuntimeService } from 'runtime/contracts/gen/doric/runtime/v2/runtime_pb.js';
import { TerminalService } from 'terminal/contracts/gen/doric/terminal/v1/terminal_pb.js';

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
import * as projectsApi from '../../contracts/gen/doric/api/projects/v1/projects_pb.js';
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
import * as threadsApi from '../../contracts/gen/doric/api/threads/v1/threads_pb.js';
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
import { projectOperations } from '../api/operations/projects.js';
import { providerOperations } from '../api/operations/providers.js';
import { terminalOperations } from '../api/operations/terminals.js';
import { threadOperations } from '../api/operations/threads.js';
import type { TransportPorts } from '../api/ports.js';
import { invalidApiInput } from '../api/violations.js';
import { routedTransportPorts } from './routed.js';
import {
  API_PAGE_MAX_BYTES,
  keptBefore,
  projectWatch,
  statusWatch,
  threadWatch,
} from './watch.js';

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
  readonly projects: ServiceImpl<typeof ProjectsService>;
  readonly threads: ServiceImpl<typeof ThreadsService>;
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
  projects: projectOperations(ports),
  threads: threadOperations(ports),
  terminals: terminalOperations(ports),
});

type Operations = ReturnType<typeof operationsOf>;

const notActive = (): ContractError =>
  new ContractError('unavailable', 'transport is not active.');

const same = (value: unknown): unknown => value;
const empty = (): unknown => ({});

/** Today's `202 {status: 'pending'}` as the API's `Pending` (`Retry-After: 1`). */
const pending = { pending: { retryAfterSeconds: 1 } };

/** The longest code-unit length of one `ReadFile` `content` item (D7). */
const CONTENT_CHUNK = 1_048_576;

/** `text` in pieces of at most `CONTENT_CHUNK` code units, never inside a surrogate pair; none for empty text. */
const chunksOf = (text: string): string[] => {
  const chunks: string[] = [];

  for (let start = 0; start < text.length; ) {
    let end = Math.min(start + CONTENT_CHUNK, text.length);
    const last = text.charCodeAt(end - 1);

    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    chunks.push(text.slice(start, end));
    start = end;
  }

  return chunks;
};

/** The encoded size of `value` as `schema` (D6). */
const sizeOf = <D extends DescMessage>(schema: D, value: unknown): number =>
  toBinary(schema, encode(schema, value)).length;

/** `ListThreads`' `{threadPage}`, its items cut under 3 MiB with `nextCursor` at the last kept id when cut (D6). */
const threadPageOf = (page: {
  readonly items: readonly { readonly id: string }[];
}): unknown => {
  const pageOf = (items: readonly { readonly id: string }[]) => ({
    threadPage:
      items.length === page.items.length
        ? page
        : { ...page, items, nextCursor: items.at(-1)?.id },
  });
  const kept = keptBefore(
    page.items,
    (items) => sizeOf(projectsApi.ListThreadsResponseSchema, pageOf(items)),
    API_PAGE_MAX_BYTES,
  );

  return pageOf(page.items.slice(0, kept));
};

/** `ListEvents`' `{threadEventLog, nextAfterSequence?}`, the events cut under 3 MiB (D6). */
const eventLogOf = (log: {
  readonly events: readonly { readonly sequence: number }[];
}): unknown => {
  const logOf = (events: readonly { readonly sequence: number }[]) =>
    events.length === log.events.length
      ? { threadEventLog: log }
      : {
          threadEventLog: { ...log, events },
          nextAfterSequence: events.at(-1)?.sequence,
        };
  const kept = keptBefore(
    log.events,
    (events) => sizeOf(threadsApi.ListEventsResponseSchema, logOf(events)),
    API_PAGE_MAX_BYTES,
  );

  return logOf(log.events.slice(0, kept));
};

/** `GetGit` / `ListBranches`: `{status, value?}` from today's body (the value, or `{status}` when not ready). */
const readinessOf = (value: object): unknown =>
  'status' in value &&
  (value.status === 'pending' || value.status === 'unavailable')
    ? { status: value.status }
    : { status: 'ready', value };

/** Builds the part with no I/O; never throws. */
export const createTransportHost = (): TransportHost => {
  const hooks = createHookHandlers();
  let operations: Operations | undefined;
  /** The router clients the Watch streams open, set while active. */
  let clients: Pick<HostServices, 'use'> | undefined;
  /** Wakes the open streams when the part stops answering. */
  const stopping = new Set<() => void>();

  const active = (): Operations => {
    if (operations === undefined) throw notActive();

    return operations;
  };

  /** `select`'s operation on `input`; anything it throws ends with `apiFailure`. */
  const run = async <V>(
    select: (current: Operations) => Op<V>,
    input: RouteInput,
  ): Promise<ApiAnswer<V>> => {
    const operation = select(active());

    try {
      return await operation(input);
    } catch (error) {
      throw apiFailure(error);
    }
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
    const value = answerValue(await run(select, input));

    try {
      return encode(schema, wrap(value));
    } catch (error) {
      throw apiFailure(error);
    }
  };

  /**
   * One workspace read (`oneof result`): `{pending: {retryAfterSeconds: 1}}` for a pending answer, else `{value}` with
   * the route's body; a refusal ends with `apiError`.
   */
  const read = async <V, D extends DescMessage>(
    select: (current: Operations) => Op<V>,
    input: RouteInput,
    schema: D,
  ): Promise<MessageShape<D>> => {
    const answer = await run(select, input);
    const value =
      answer.kind === 'pending' ? pending : { value: answerValue(answer) };

    try {
      return encode(schema, value);
    } catch (error) {
      throw apiFailure(error);
    }
  };

  /**
   * An open Watch: `open`'s stream until it ends or the call's signal aborts; `deactivate` ends it with `unavailable`.
   */
  async function* watched<T>(
    context: HandlerContext,
    open: (
      services: Pick<HostServices, 'use'>,
      signal: AbortSignal,
    ) => AsyncIterable<T>,
  ): AsyncIterable<T> {
    const services = clients;

    if (services === undefined) throw notActive();
    const call = callOf(context).signal;
    const controller = new AbortController();
    let deactivated = false;
    const end = () => controller.abort();
    const stop = () => {
      deactivated = true;
      controller.abort();
    };

    call.addEventListener('abort', end, { once: true });
    if (call.aborted) end();
    stopping.add(stop);
    try {
      yield* open(services, controller.signal);
    } finally {
      stopping.delete(stop);
      call.removeEventListener('abort', end);
      controller.abort();
    }
    if (deactivated) throw notActive();
  }

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
    projects: {
      createProject: (request) =>
        unary(
          ({ projects }) => projects.create,
          routeInputOf(projectsApi.CreateProjectRequestSchema, request, {}),
          projectsApi.CreateProjectResponseSchema,
          ({ ssh, ...project }) => ({ project, ssh }),
        ),
      listProjects: (request) =>
        unary(
          ({ projects }) => projects.list,
          routeInputOf(projectsApi.ListProjectsRequestSchema, request, {}),
          projectsApi.ListProjectsResponseSchema,
          same,
        ),
      getProject: (request) =>
        unary(
          ({ projects }) => projects.get,
          routeInputOf(projectsApi.GetProjectRequestSchema, request, {
            projectId: 'id',
          }),
          projectsApi.GetProjectResponseSchema,
          (value) => ({ project: value }),
        ),
      updateProject: (request) =>
        unary(
          ({ projects }) => projects.rename,
          routeInputOf(projectsApi.UpdateProjectRequestSchema, request, {
            projectId: 'id',
          }),
          projectsApi.UpdateProjectResponseSchema,
          (value) => ({ project: value }),
        ),
      setProjectColor: (request) =>
        unary(
          ({ projects }) => projects.setColor,
          {
            ...routeInputOf(projectsApi.SetProjectColorRequestSchema, request, {
              projectId: 'id',
            }),
            body: { color: request.color ?? null },
          },
          projectsApi.SetProjectColorResponseSchema,
          (value) => ({ project: value }),
        ),
      createThread: (request) =>
        unary(
          ({ projects }) => projects.createThread,
          routeInputOf(projectsApi.CreateThreadRequestSchema, request, {
            projectId: 'id',
          }),
          projectsApi.CreateThreadResponseSchema,
          (value) => ({ thread: value }),
        ),
      listThreads: (request) =>
        unary(
          ({ projects }) => projects.listThreads,
          routeInputOf(projectsApi.ListThreadsRequestSchema, request, {
            projectId: 'id',
          }),
          projectsApi.ListThreadsResponseSchema,
          threadPageOf,
        ),
      getProjectSsh: (request) =>
        read(
          ({ projects }) => projects.ssh,
          routeInputOf(projectsApi.GetProjectSshRequestSchema, request, {
            projectId: 'id',
          }),
          projectsApi.GetProjectSshResponseSchema,
        ),
      listFiles: (request) =>
        read(
          ({ projects }) => projects.files,
          routeInputOf(projectsApi.ListFilesRequestSchema, request, {
            projectId: 'id',
          }),
          projectsApi.ListFilesResponseSchema,
        ),
      getTree: (request) =>
        read(
          ({ projects }) => projects.tree,
          routeInputOf(projectsApi.GetTreeRequestSchema, request, {
            projectId: 'id',
          }),
          projectsApi.GetTreeResponseSchema,
        ),
      async *readFile(request, context) {
        const answer = await run(
          ({ projects }) => projects.content,
          routeInputOf(projectsApi.ReadFileRequestSchema, request, {
            projectId: 'id',
          }),
        );
        const { signal } = callOf(context);

        if (answer.kind === 'pending') {
          yield encode(projectsApi.ReadFileResponseSchema, pending);
          return;
        }
        const { path, content, truncated, binary } = answerValue(answer);

        yield encode(projectsApi.ReadFileResponseSchema, {
          head: { status: 'read', path, truncated, binary },
        });
        for (const chunk of chunksOf(content)) {
          if (signal.aborted) return;
          active();
          yield encode(projectsApi.ReadFileResponseSchema, { content: chunk });
        }
      },
      getDiff: (request) =>
        read(
          ({ projects }) => projects.diff,
          routeInputOf(projectsApi.GetDiffRequestSchema, request, {
            projectId: 'id',
          }),
          projectsApi.GetDiffResponseSchema,
        ),
      listChanges: (request) =>
        read(
          ({ projects }) => projects.changes,
          routeInputOf(projectsApi.ListChangesRequestSchema, request, {
            projectId: 'id',
          }),
          projectsApi.ListChangesResponseSchema,
        ),
      getFileDiff: (request) =>
        read(
          ({ projects }) => projects.fileDiff,
          routeInputOf(projectsApi.GetFileDiffRequestSchema, request, {
            projectId: 'id',
          }),
          projectsApi.GetFileDiffResponseSchema,
        ),
      getProjectResources: (request) =>
        read(
          ({ projects }) => projects.resources,
          routeInputOf(projectsApi.GetProjectResourcesRequestSchema, request, {
            projectId: 'id',
          }),
          projectsApi.GetProjectResourcesResponseSchema,
        ),
      listTerminals: (request) =>
        unary(
          ({ terminals }) => terminals.list,
          routeInputOf(projectsApi.ListTerminalsRequestSchema, request, {
            projectId: 'id',
          }),
          projectsApi.ListTerminalsResponseSchema,
          same,
        ),
      terminateProject: (request) =>
        unary(
          ({ projects }) => projects.terminate,
          routeInputOf(projectsApi.TerminateProjectRequestSchema, request, {
            projectId: 'id',
          }),
          projectsApi.TerminateProjectResponseSchema,
          (value) => ({ project: value }),
        ),
      deleteProject: (request) =>
        unary(
          ({ projects }) => projects.remove,
          routeInputOf(projectsApi.DeleteProjectRequestSchema, request, {
            projectId: 'id',
          }),
          projectsApi.DeleteProjectResponseSchema,
          empty,
        ),
      watch: (request, context) =>
        watched(context, (services, signal) =>
          projectWatch(
            services.use(RuntimeService),
            services.use(TerminalService),
            request.projectId,
            signal,
          ),
        ),
    },
    threads: {
      getThread: (request) =>
        unary(
          ({ threads }) => threads.get,
          routeInputOf(threadsApi.GetThreadRequestSchema, request, {
            threadId: 'id',
          }),
          threadsApi.GetThreadResponseSchema,
          (value) => ({ thread: value }),
        ),
      updateThread: (request) =>
        unary(
          ({ threads }) => threads.update,
          routeInputOf(threadsApi.UpdateThreadRequestSchema, request, {
            threadId: 'id',
          }),
          threadsApi.UpdateThreadResponseSchema,
          (value) => ({ thread: value }),
        ),
      getGit: (request) =>
        unary(
          ({ threads }) => threads.git,
          routeInputOf(threadsApi.GetGitRequestSchema, request, {
            threadId: 'id',
          }),
          threadsApi.GetGitResponseSchema,
          readinessOf,
        ),
      listBranches: (request) =>
        unary(
          ({ threads }) => threads.branches,
          routeInputOf(threadsApi.ListBranchesRequestSchema, request, {
            threadId: 'id',
          }),
          threadsApi.ListBranchesResponseSchema,
          readinessOf,
        ),
      createBranch: (request) =>
        unary(
          ({ threads }) => threads.switchBranch,
          routeInputOf(threadsApi.CreateBranchRequestSchema, request, {
            threadId: 'id',
          }),
          threadsApi.CreateBranchResponseSchema,
          (value) => ({ branches: value }),
        ),
      prompt: (request) =>
        unary(
          ({ threads }) => threads.prompt,
          routeInputOf(threadsApi.PromptRequestSchema, request, {
            threadId: 'id',
          }),
          threadsApi.PromptResponseSchema,
          same,
        ),
      steer: (request) =>
        unary(
          ({ threads }) => threads.steer,
          routeInputOf(threadsApi.SteerRequestSchema, request, {
            threadId: 'id',
          }),
          threadsApi.SteerResponseSchema,
          same,
        ),
      resume: (request) =>
        unary(
          ({ threads }) => threads.resume,
          routeInputOf(threadsApi.ResumeRequestSchema, request, {
            threadId: 'id',
          }),
          threadsApi.ResumeResponseSchema,
          (value) => ({ thread: value }),
        ),
      rewind: (request) =>
        unary(
          ({ threads }) => threads.rewind,
          routeInputOf(threadsApi.RewindRequestSchema, request, {
            threadId: 'id',
          }),
          threadsApi.RewindResponseSchema,
          same,
        ),
      compact: (request) =>
        unary(
          ({ threads }) => threads.compact,
          routeInputOf(threadsApi.CompactRequestSchema, request, {
            threadId: 'id',
          }),
          threadsApi.CompactResponseSchema,
          same,
        ),
      interrupt: (request) =>
        unary(
          ({ threads }) => threads.interrupt,
          routeInputOf(threadsApi.InterruptRequestSchema, request, {
            threadId: 'id',
          }),
          threadsApi.InterruptResponseSchema,
          same,
        ),
      listEvents: (request) =>
        unary(
          ({ threads }) => threads.events,
          routeInputOf(threadsApi.ListEventsRequestSchema, request, {
            threadId: 'id',
          }),
          threadsApi.ListEventsResponseSchema,
          eventLogOf,
        ),
      getUsage: (request) =>
        unary(
          ({ threads }) => threads.usage,
          routeInputOf(threadsApi.GetUsageRequestSchema, request, {
            threadId: 'id',
          }),
          threadsApi.GetUsageResponseSchema,
          (value) => ({ threadUsage: value }),
        ),
      getQueue: (request) =>
        unary(
          ({ threads }) => threads.queue,
          routeInputOf(threadsApi.GetQueueRequestSchema, request, {
            threadId: 'id',
          }),
          threadsApi.GetQueueResponseSchema,
          (value) => ({ threadQueue: value }),
        ),
      resumeQueue: (request) =>
        unary(
          ({ threads }) => threads.resumeQueue,
          routeInputOf(threadsApi.ResumeQueueRequestSchema, request, {
            threadId: 'id',
          }),
          threadsApi.ResumeQueueResponseSchema,
          (value) => ({ thread: value }),
        ),
      getQueuedPrompt: (request) =>
        unary(
          ({ threads }) => threads.queuedPrompt,
          routeInputOf(threadsApi.GetQueuedPromptRequestSchema, request, {
            threadId: 'id',
            promptId: 'promptId',
          }),
          threadsApi.GetQueuedPromptResponseSchema,
          (value) => ({ queuedPrompt: value }),
        ),
      updateQueuedPrompt: (request) =>
        unary(
          ({ threads }) => threads.editQueued,
          routeInputOf(threadsApi.UpdateQueuedPromptRequestSchema, request, {
            threadId: 'id',
            promptId: 'promptId',
          }),
          threadsApi.UpdateQueuedPromptResponseSchema,
          (value) => ({ queuedPrompt: value }),
        ),
      deleteQueuedPrompt: (request) =>
        unary(
          ({ threads }) => threads.removeQueued,
          routeInputOf(threadsApi.DeleteQueuedPromptRequestSchema, request, {
            threadId: 'id',
            promptId: 'promptId',
          }),
          threadsApi.DeleteQueuedPromptResponseSchema,
          empty,
        ),
      createTerminal: (request) =>
        unary(
          ({ terminals }) => terminals.create,
          routeInputOf(threadsApi.CreateTerminalRequestSchema, request, {
            threadId: 'id',
          }),
          threadsApi.CreateTerminalResponseSchema,
          (value) => ({ terminalSession: value }),
        ),
      terminateThread: (request) =>
        unary(
          ({ threads }) => threads.terminate,
          routeInputOf(threadsApi.TerminateThreadRequestSchema, request, {
            threadId: 'id',
          }),
          threadsApi.TerminateThreadResponseSchema,
          (value) => ({ thread: value }),
        ),
      deleteThread: (request) =>
        unary(
          ({ threads }) => threads.remove,
          routeInputOf(threadsApi.DeleteThreadRequestSchema, request, {
            threadId: 'id',
          }),
          threadsApi.DeleteThreadResponseSchema,
          empty,
        ),
      watch: (request, context) =>
        watched(context, (services, signal) =>
          threadWatch(services.use(RuntimeThreadsService), request, signal),
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
      watch: (_request, context) =>
        watched(context, (_services, signal) => statusWatch(signal)),
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
      clients = context.services;
      operations = operationsOf(ports);
    },
    deactivate: () => {
      operations = undefined;
      clients = undefined;
      for (const wake of [...stopping]) wake();

      return Promise.resolve();
    },
  };
};
