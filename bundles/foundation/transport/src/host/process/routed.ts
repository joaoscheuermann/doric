// `TransportPorts` over the router (S60c, contract s60 §2.8, D2).

import type {
  DescMessage,
  DescService,
  MessageShape,
} from '@bufbuild/protobuf';
import type { Client } from '@connectrpc/connect';
import {
  ContractError,
  isContractError,
  type ToolCatalogEntry,
  toContractError,
} from 'bundle/contracts';
import {
  CatalogRequestSchema,
  CatalogResponseSchema,
  KindResponseSchema,
  KindsResponseSchema as ModelKindsResponseSchema,
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
  ToolCatalogEntrySchema,
  ToolsService,
} from 'bundle/contracts/gen/doric/tools/v1/tools_pb.js';
import {
  contractErrorOf,
  type HostServices,
  type UseOptions,
} from 'bundle/host';
import {
  ContentRequestSchema,
  ContentResponseSchema,
  DirectoryRequestSchema,
  DirectoryResponseSchema,
  FilesService,
  TreeRequestSchema,
  TreeResponseSchema,
} from 'files/contracts/gen/doric/files/v1/files_pb.js';
import {
  BranchesResponseSchema,
  ChangesRequestSchema,
  ChangesResponseSchema,
  CommandsService,
  DiffRequestSchema,
  DiffResponseSchema,
  FileDiffRequestSchema,
  FileDiffResponseSchema,
  StatusResponseSchema,
  SwitchBranchRequestSchema,
  SwitchBranchResponseSchema,
} from 'git/contracts/gen/doric/git/commands/v1/commands_pb.js';
import {
  CurrentResponseSchema,
  HostConfigService,
  ReplaceRequestSchema,
  ReplaceResponseSchema,
} from 'host-config/contracts/gen/doric/host_config/v1/host_config_pb.js';
import {
  HostResponseSchema,
  ProjectResponseSchema as ProjectResourcesResponseSchema,
  ResourcesService,
} from 'resources/contracts/gen/doric/resources/v1/resources_pb.js';
import {
  decode,
  encode,
  runOnProjectLease,
  runtimeOneofs,
} from 'runtime/contracts';
import { LeaseService } from 'runtime/contracts/gen/doric/runtime/lease/v1/lease_pb.js';
import {
  CompactResponseSchema,
  CreateThreadRequestSchema,
  CreateThreadResponseSchema,
  DeleteThreadResponseSchema,
  EditQueuedRequestSchema,
  EditQueuedResponseSchema,
  PauseResponseSchema,
  PromptRequestSchema,
  PromptResponseSchema,
  QueuedPromptResponseSchema,
  QueueResponseSchema,
  RemoveQueuedResponseSchema,
  RenameThreadRequestSchema,
  RenameThreadResponseSchema,
  ResumeQueueResponseSchema,
  ResumeResponseSchema,
  RewindRequestSchema,
  RewindResponseSchema,
  SetThreadCwdRequestSchema,
  SetThreadCwdResponseSchema,
  SetThreadExecutionRequestSchema,
  SetThreadExecutionResponseSchema,
  SteerRequestSchema,
  SteerResponseSchema,
  TerminateThreadResponseSchema,
  ThreadEventsRequestSchema,
  ThreadEventsResponseSchema,
  ThreadResponseSchema,
  ThreadsRequestSchema,
  ThreadsResponseSchema,
  ThreadsService,
} from 'runtime/contracts/gen/doric/runtime/threads/v1/threads_pb.js';
import {
  CreateProjectRequestSchema,
  CreateProjectResponseSchema,
  DeleteProjectResponseSchema,
  ProjectResponseSchema,
  ProjectsRequestSchema,
  ProjectsResponseSchema,
  RenameProjectRequestSchema,
  RenameProjectResponseSchema,
  RuntimeService,
  SetProjectColorRequestSchema,
  SetProjectColorResponseSchema,
  TerminateProjectResponseSchema,
  VmSshResponseSchema,
} from 'runtime/contracts/gen/doric/runtime/v2/runtime_pb.js';
import {
  MachineResponseSchema,
  MachinesResponseSchema,
  SandboxService,
  SandboxSshAccessSchema,
} from 'runtime/contracts/gen/doric/sandbox/v1/sandbox_pb.js';
import {
  InputResponseSchema,
  ResizeResponseSchema,
  SnapshotResponseSchema,
  StopResponseSchema,
  CreateRequestSchema as TerminalCreateRequestSchema,
  CreateResponseSchema as TerminalCreateResponseSchema,
  ListResponseSchema as TerminalListResponseSchema,
  TerminalService,
} from 'terminal/contracts/gen/doric/terminal/v1/terminal_pb.js';
import {
  UsageService,
  ThreadResponseSchema as UsageThreadResponseSchema,
} from 'usage/contracts/gen/doric/usage/v1/usage_pb.js';

import type { TransportPorts } from '../api/ports.js';

type Json = Readonly<Record<string, unknown>>;

/** Runs `work`, rejecting with the `ContractError` of its failure (`contractErrorOf`, else `internal`). */
const routed = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    throw toContractError(contractErrorOf(error));
  }
};

/** `value` (today's JSON) as a request message of `schema`. */
const request = <D extends DescMessage>(
  schema: D,
  value: unknown,
): MessageShape<D> => encode(schema, value, runtimeOneofs);

/**
 * `message` as today's JSON (D2): the message encodes the kernel value, so its decoded JSON is that value. `T` is the
 * kernel value's type, as the port names it.
 */
const kernelValue = <D extends DescMessage, T>(
  schema: D,
  message: MessageShape<D>,
): T => decode(schema, message, runtimeOneofs) as T;

/** The answer of `call` as the kernel value it encodes ({@link kernelValue}). */
const answer = <D extends DescMessage, T>(
  schema: D,
  call: () => Promise<MessageShape<D>>,
): Promise<T> => routed(async () => kernelValue<D, T>(schema, await call()));

/** The `key` field of `call`'s answer as today's JSON; `undefined` when the message leaves it unset. */
const field = <D extends DescMessage, T>(
  schema: D,
  key: string,
  call: () => Promise<MessageShape<D>>,
): Promise<T | undefined> =>
  routed(
    async () =>
      kernelValue<D, Json>(schema, await call())[key] as T | undefined,
  );

/** As {@link field}, for a field the kernel value always has: unset rejects with `invalid_output`. */
const required = async <D extends DescMessage, T>(
  schema: D,
  key: string,
  call: () => Promise<MessageShape<D>>,
): Promise<T> => {
  const value = await field<D, T>(schema, key, call);

  if (value === undefined) {
    throw new ContractError(
      'invalid_output',
      `${schema.typeName} answered no ${key}.`,
    );
  }

  return value;
};

/**
 * `TransportPorts` over the generated clients of §0.4; creating it makes no call. Every call is made inside the
 * handler's call (scope, deadline, signal inherited; **no deadline added**); lease, files, git (`ProjectScope` form)
 * and resources calls carry `{scope: {projectId}}` or `{threadId}` as the kernel binds them. Answers are `decode`d to
 * today's JSON and unwrapped to the kernel value:
 * - `runtime.project`/`renameProject`/`setProjectColor`/`terminateProject` → `undefined` when the answer has no
 *   `project`; `threads.thread`/`renameThread`/`terminateThread`/`threadEvents`/`threads`/`queue`/`queuedPrompt`,
 *   `usage.thread`, `runtime.vmSsh`, `sandbox.machine`, `models.kind` likewise when absent (a `NOT_FOUND`
 *   `unknown_kind` from `Kind` also reads as `undefined`);
 * - `lease(scope).ssh()` = `runOnProjectLease(LeaseService with scope, steps => steps.step(() => Ssh{target}))`:
 *   `{status}` for a lease failure, `{status: 'unavailable'}` when `Ssh` answers no access, else
 *   `{status: 'ready', vmId, ssh}`;
 * - `tools.list()` = `ToolsService.Catalog{}` entries as `{tool: entry}`;
 * - outcome unions (`prompt`, `steer`, `resume`, `rewind`, `compact`, `pause`, `deleteThread`, `deleteProject`,
 *   `createThread`, `editQueued`, `removeQueued`, `resumeQueue`, `setThreadCwd`, `setThreadExecution`,
 *   `configuration.replace`, `models.catalog`, files/git/resources reads, `terminal.*`) as data, unchanged.
 * Rejects with `contractErrorOf` of the call's failure (a missing optional provider is `unavailable`).
 */
export const routedTransportPorts = (
  services: Pick<HostServices, 'use'>,
): TransportPorts => {
  // A client is created at its first call: `use` makes no call, but throws for a scope out of bounds, which then
  // rejects that call.
  const client =
    <S extends DescService>(service: S, options?: UseOptions<S>) =>
    (): Client<S> =>
      services.use(service, options);

  const runtime = client(RuntimeService);
  const threads = client(ThreadsService);
  const usage = client(UsageService);
  const terminal = client(TerminalService);
  const sandbox = client(SandboxService);
  const tools = client(ToolsService);
  const models = client(ModelsService);
  const secrets = client(SecretsService);
  const hostConfig = client(HostConfigService);

  return {
    runtime: {
      createProject: (input) =>
        required(CreateProjectResponseSchema, 'project', () =>
          runtime().createProject(request(CreateProjectRequestSchema, input)),
        ),
      projects: (page) =>
        answer(ProjectsResponseSchema, () =>
          runtime().projects(request(ProjectsRequestSchema, page)),
        ),
      renameProject: (input) =>
        field(RenameProjectResponseSchema, 'project', () =>
          runtime().renameProject(request(RenameProjectRequestSchema, input)),
        ),
      setProjectColor: (input) =>
        field(SetProjectColorResponseSchema, 'project', () =>
          runtime().setProjectColor(
            request(SetProjectColorRequestSchema, input),
          ),
        ),
      project: (id) =>
        field(ProjectResponseSchema, 'project', () =>
          runtime().project({ id }),
        ),
      terminateProject: (id) =>
        field(TerminateProjectResponseSchema, 'project', () =>
          runtime().terminateProject({ id }),
        ),
      deleteProject: (id) =>
        required(DeleteProjectResponseSchema, 'deleteResult', () =>
          runtime().deleteProject({ id }),
        ),
      vmSsh: (vmId) =>
        field(VmSshResponseSchema, 'vmSsh', () => runtime().vmSsh({ vmId })),
    },
    threads: {
      createThread: (input) =>
        answer(CreateThreadResponseSchema, () =>
          threads().createThread(request(CreateThreadRequestSchema, input)),
        ),
      threads: (input) =>
        field(ThreadsResponseSchema, 'threadPage', () =>
          threads().threads(request(ThreadsRequestSchema, input)),
        ),
      thread: (id) =>
        field(ThreadResponseSchema, 'thread', () => threads().thread({ id })),
      renameThread: (input) =>
        field(RenameThreadResponseSchema, 'thread', () =>
          threads().renameThread(request(RenameThreadRequestSchema, input)),
        ),
      setThreadCwd: (input) =>
        answer(SetThreadCwdResponseSchema, () =>
          threads().setThreadCwd(request(SetThreadCwdRequestSchema, input)),
        ),
      setThreadExecution: (input) =>
        answer(SetThreadExecutionResponseSchema, () =>
          threads().setThreadExecution(
            request(SetThreadExecutionRequestSchema, input),
          ),
        ),
      prompt: (input) =>
        required(PromptResponseSchema, 'promptResult', () =>
          threads().prompt(request(PromptRequestSchema, input)),
        ),
      steer: (input) =>
        required(SteerResponseSchema, 'steerResult', () =>
          threads().steer(request(SteerRequestSchema, input)),
        ),
      resume: ({ id, promptId }) =>
        required(ResumeResponseSchema, 'resumeResult', () =>
          threads().resume({ id, promptId }),
        ),
      rewind: (input) =>
        answer(RewindResponseSchema, () =>
          threads().rewind(request(RewindRequestSchema, input)),
        ),
      compact: ({ id }) =>
        answer(CompactResponseSchema, () => threads().compact({ id })),
      threadEvents: (input) =>
        field(ThreadEventsResponseSchema, 'threadEventLog', () =>
          threads().threadEvents(request(ThreadEventsRequestSchema, input)),
        ),
      pause: ({ id, promptId }) =>
        required(PauseResponseSchema, 'interruptResult', () =>
          threads().pause({ id, promptId }),
        ),
      terminateThread: (id) =>
        field(TerminateThreadResponseSchema, 'thread', () =>
          threads().terminateThread({ id }),
        ),
      deleteThread: (id) =>
        required(DeleteThreadResponseSchema, 'deleteResult', () =>
          threads().deleteThread({ id }),
        ),
      queue: (id) =>
        field(QueueResponseSchema, 'threadQueue', () =>
          threads().queue({ id }),
        ),
      resumeQueue: (id) =>
        required(ResumeQueueResponseSchema, 'resumeResult', () =>
          threads().resumeQueue({ id }),
        ),
      queuedPrompt: ({ id, promptId }) =>
        field(QueuedPromptResponseSchema, 'queuedPrompt', () =>
          threads().queuedPrompt({ id, promptId }),
        ),
      editQueued: (input) =>
        answer(EditQueuedResponseSchema, () =>
          threads().editQueued(request(EditQueuedRequestSchema, input)),
        ),
      removeQueued: ({ id, promptId }) =>
        required(RemoveQueuedResponseSchema, 'removeQueuedResult', () =>
          threads().removeQueued({ id, promptId }),
        ),
    },
    lease: (scope) => ({
      ssh: () =>
        routed(async () => {
          const lease = services.use(LeaseService, { scope });
          const outcome = await runOnProjectLease(lease, (steps) =>
            steps.step(() => lease.ssh({ target: steps.target })),
          );

          if (outcome.status !== 'ready') return { status: outcome.status };

          const { vmId, response } = outcome.value;

          return response === undefined
            ? { status: 'unavailable' }
            : {
                status: 'ready',
                vmId,
                ssh: kernelValue(SandboxSshAccessSchema, response),
              };
        }),
    }),
    files: (scope) => {
      const files = client(FilesService, { scope });

      return {
        directory: (input) =>
          answer(DirectoryResponseSchema, () =>
            files().directory(request(DirectoryRequestSchema, input)),
          ),
        tree: (input) =>
          answer(TreeResponseSchema, () =>
            files().tree(request(TreeRequestSchema, input)),
          ),
        content: (input) =>
          answer(ContentResponseSchema, () =>
            files().content(request(ContentRequestSchema, input)),
          ),
      };
    },
    git: (scope) => {
      const git = client(
        CommandsService,
        scope === undefined ? undefined : { scope },
      );

      return {
        status: (threadId) =>
          answer(StatusResponseSchema, () => git().status({ threadId })),
        branches: (threadId) =>
          answer(BranchesResponseSchema, () => git().branches({ threadId })),
        switchBranch: (input) =>
          answer(SwitchBranchResponseSchema, () =>
            git().switchBranch(request(SwitchBranchRequestSchema, input)),
          ),
        diff: (input) =>
          answer(DiffResponseSchema, () =>
            git().diff(request(DiffRequestSchema, input)),
          ),
        changes: (input) =>
          answer(ChangesResponseSchema, () =>
            git().changes(request(ChangesRequestSchema, input)),
          ),
        fileDiff: (input) =>
          answer(FileDiffResponseSchema, () =>
            git().fileDiff(request(FileDiffRequestSchema, input)),
          ),
      };
    },
    usage: {
      thread: (threadId) =>
        field(UsageThreadResponseSchema, 'threadUsage', () =>
          usage().thread({ threadId }),
        ),
    },
    resources: (scope) => {
      const resources = client(
        ResourcesService,
        scope === undefined ? undefined : { scope },
      );

      return {
        host: () => answer(HostResponseSchema, () => resources().host({})),
        project: () =>
          answer(ProjectResourcesResponseSchema, () => resources().project({})),
      };
    },
    terminal: {
      list: (projectId) =>
        required(TerminalListResponseSchema, 'terminals', () =>
          terminal().list({ projectId }),
        ),
      create: (threadId, size) =>
        field(TerminalCreateResponseSchema, 'terminalSession', () =>
          terminal().create(
            request(TerminalCreateRequestSchema, { threadId, ...size }),
          ),
        ),
      snapshot: (terminalId, after) =>
        field(SnapshotResponseSchema, 'terminalSnapshot', () =>
          terminal().snapshot({ terminalId, after }),
        ),
      input: (terminalId, data) =>
        required(InputResponseSchema, 'sent', () =>
          terminal().input({ terminalId, data }),
        ),
      resize: (terminalId, cols, rows) =>
        required(ResizeResponseSchema, 'resized', () =>
          terminal().resize({ terminalId, cols, rows }),
        ),
      stop: (terminalId) =>
        required(StopResponseSchema, 'stopped', () =>
          terminal().stop({ terminalId }),
        ),
    },
    sandbox: {
      machines: () =>
        required(MachinesResponseSchema, 'machines', () =>
          sandbox().machines({}),
        ),
      machine: (id) =>
        field(MachineResponseSchema, 'runningMachine', () =>
          sandbox().machine({ id }),
        ),
    },
    tools: {
      list: () =>
        routed(async () =>
          (await tools().catalog({})).entries.map((entry) => ({
            tool: kernelValue<typeof ToolCatalogEntrySchema, ToolCatalogEntry>(
              ToolCatalogEntrySchema,
              entry,
            ),
          })),
        ),
    },
    models: {
      kinds: () =>
        required(ModelKindsResponseSchema, 'kinds', () => models().kinds({})),
      kind: async (id) => {
        try {
          return await field(KindResponseSchema, 'modelKindDescriptor', () =>
            models().kind({ id }),
          );
        } catch (error) {
          if (isContractError(error) && error.code === 'unknown_kind') {
            return undefined;
          }

          throw error;
        }
      },
      catalog: (input) =>
        required(CatalogResponseSchema, 'catalogResult', () =>
          models().catalog(request(CatalogRequestSchema, input)),
        ),
    },
    secrets: {
      list: () =>
        required(ListResponseSchema, 'credentials', () => secrets().list({})),
      kinds: () =>
        required(CredentialKindsResponseSchema, 'kinds', () =>
          secrets().kinds({}),
        ),
      create: (input) =>
        required(CreateResponseSchema, 'credentialDescription', () =>
          secrets().create(request(CreateRequestSchema, input)),
        ),
      update: (ref, input) =>
        required(UpdateResponseSchema, 'credentialDescription', () =>
          secrets().update(
            request(UpdateRequestSchema, { ref, update: input }),
          ),
        ),
      delete: (ref) =>
        required(DeleteResponseSchema, 'result', () =>
          secrets().delete(
            request(DeleteRequestSchema, { credentialRef: ref }),
          ),
        ),
    },
    configuration: {
      current: () =>
        required(CurrentResponseSchema, 'doricConfiguration', () =>
          hostConfig().current({}),
        ),
      replace: (input) =>
        answer(ReplaceResponseSchema, () =>
          hostConfig().replace(request(ReplaceRequestSchema, { input })),
        ),
    },
  };
};
