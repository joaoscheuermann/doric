// The router fakes of the generated services the routes call (S60c/d), driven
// by domain fakes (`Fakes`, one per consumed contract): each fake
// decodes its request to today's arguments (`decode`), records it (its JSON,
// scope and deadline), calls the domain method with them and the hop `Call`
// last and answers its value `encode`d into the response
// message. A domain method that throws fails the call with its error (a
// `ContractError` keeps its code); a missing one fails `internal`. The three
// workspace streams are served from `Streams` (proto JSON items).

import {
  type DescMessage,
  type JsonValue,
  type MessageShape,
  toJson,
} from '@bufbuild/protobuf';
import type { HandlerContext } from '@connectrpc/connect';
import { ContractError, callOf } from 'bundle/contracts';
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
  ContentRequestSchema,
  ContentResponseSchema,
  DirectoryRequestSchema,
  DirectoryResponseSchema,
  FilesService,
  TreeRequestSchema,
  TreeResponseSchema,
} from 'files/contracts/gen/doric/files/v1/files_pb.js';
import {
  BranchesRequestSchema,
  BranchesResponseSchema,
  ChangesRequestSchema,
  ChangesResponseSchema,
  CommandsService,
  DiffRequestSchema,
  DiffResponseSchema,
  FileDiffRequestSchema,
  FileDiffResponseSchema,
  StatusRequestSchema,
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
import { decode, encode, runtimeOneofs } from 'runtime/contracts';
import {
  DescribeRequestSchema,
  DescribeResponseSchema,
  LeaseService,
  SshRequestSchema,
  SshResponseSchema,
} from 'runtime/contracts/gen/doric/runtime/lease/v1/lease_pb.js';
import {
  CompactRequestSchema,
  CompactResponseSchema,
  CreateThreadRequestSchema,
  CreateThreadResponseSchema,
  DeleteThreadRequestSchema,
  DeleteThreadResponseSchema,
  EditQueuedRequestSchema,
  EditQueuedResponseSchema,
  PauseRequestSchema,
  PauseResponseSchema,
  PromptRequestSchema,
  PromptResponseSchema,
  QueuedPromptRequestSchema,
  QueuedPromptResponseSchema,
  QueueRequestSchema,
  QueueResponseSchema,
  RemoveQueuedRequestSchema,
  RemoveQueuedResponseSchema,
  RenameThreadRequestSchema,
  RenameThreadResponseSchema,
  ResumeQueueRequestSchema,
  ResumeQueueResponseSchema,
  ResumeRequestSchema,
  ResumeResponseSchema,
  RewindRequestSchema,
  RewindResponseSchema,
  SetThreadCwdRequestSchema,
  SetThreadCwdResponseSchema,
  SetThreadExecutionRequestSchema,
  SetThreadExecutionResponseSchema,
  SteerRequestSchema,
  SteerResponseSchema,
  TerminateThreadRequestSchema,
  TerminateThreadResponseSchema,
  ThreadEventsRequestSchema,
  ThreadEventsResponseSchema,
  ThreadRequestSchema,
  ThreadResponseSchema,
  ThreadsRequestSchema,
  ThreadsResponseSchema,
  ThreadsService,
  WatchThreadRequestSchema,
  WatchThreadResponseSchema,
} from 'runtime/contracts/gen/doric/runtime/threads/v1/threads_pb.js';
import {
  CreateProjectRequestSchema,
  CreateProjectResponseSchema,
  DeleteProjectRequestSchema,
  DeleteProjectResponseSchema,
  ProjectRequestSchema,
  ProjectResponseSchema,
  ProjectsRequestSchema,
  ProjectsResponseSchema,
  RenameProjectRequestSchema,
  RenameProjectResponseSchema,
  RuntimeService,
  SetProjectColorRequestSchema,
  SetProjectColorResponseSchema,
  TerminateProjectRequestSchema,
  TerminateProjectResponseSchema,
  VmSshRequestSchema,
  VmSshResponseSchema,
  WatchProjectRequestSchema,
  WatchProjectResponseSchema,
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
  CreateRequestSchema as TerminalCreateRequestSchema,
  CreateResponseSchema as TerminalCreateResponseSchema,
  ListRequestSchema as TerminalListRequestSchema,
  ListResponseSchema as TerminalListResponseSchema,
  TerminalService,
  WatchProjectRequestSchema as TerminalWatchProjectRequestSchema,
  WatchProjectResponseSchema as TerminalWatchProjectResponseSchema,
} from 'terminal/contracts/gen/doric/terminal/v1/terminal_pb.js';
import {
  UsageService,
  ThreadRequestSchema as UsageThreadRequestSchema,
  ThreadResponseSchema as UsageThreadResponseSchema,
} from 'usage/contracts/gen/doric/usage/v1/usage_pb.js';

import { fakeOf, type Recorder } from './router.js';
import { registeredKinds } from './router-fixtures.js';

/** A domain method: the caller's arguments, then the hop `Call`. */
// biome-ignore lint/suspicious/noExplicitAny: a fake answers whatever its case needs
type FakeMethod = (...args: any[]) => unknown;
export type Fake = Readonly<Record<string, FakeMethod>>;

/** The domain fakes of the consumed contracts, by the port that calls them. */
export interface Fakes {
  readonly runtime?: Fake;
  readonly threads?: Fake;
  /** runtime.lease/v1: only `ssh` since the stage-10 host switch. */
  readonly lease?: Fake;
  /** The stage-10 feature bundles the routes call. */
  readonly files?: Fake;
  readonly git?: Fake;
  readonly usage?: Fake;
  readonly resources?: Fake;
  /** terminal/v1 1.1.0. */
  readonly terminal?: Fake;
  readonly sandbox?: Fake;
  readonly tools?: Fake;
  readonly models?: Fake;
  readonly secrets?: Fake;
  readonly configuration?: Fake;
}

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

    const json = (
      input === undefined ? {} : decode(input, message, runtimeOneofs)
    ) as Json;

    return encode(
      output,
      wrap(await domain(...args(json), callOf(context))),
      runtimeOneofs,
    );
  };

const none = () => [] as const;
const asIs = (value: unknown) => value;
const whole = (request: Json) => [request] as const;
const byId = (request: Json) => [request.id] as const;
const byThread = (request: Json) => [request.threadId] as const;
const idAndPrompt = (request: Json) =>
  [{ id: request.id, promptId: request.promptId }] as const;

/** One server-streaming fake: the request as proto JSON in, items as proto JSON out. */
export type StreamFake = (
  request: JsonValue,
  context: HandlerContext,
) => AsyncIterable<JsonValue>;

/** The workspace streams the Watches open (S60d, D5). */
export interface Streams {
  /** `runtime/v2.WatchProject`. */
  readonly runtimeWatchProject?: StreamFake;
  /** `runtime.threads/v1.WatchThread`. */
  readonly watchThread?: StreamFake;
  /** `terminal/v1.WatchProject`. */
  readonly terminalWatchProject?: StreamFake;
}

/** One server-streaming fake method: records the request, then `encode`s each item `fake` yields. */
const stream = <I extends DescMessage, O extends DescMessage>(
  record: Recorder,
  method: string,
  input: I,
  output: O,
  fake: StreamFake,
) =>
  async function* (
    request: MessageShape<I>,
    context: HandlerContext,
  ): AsyncGenerator<MessageShape<O>> {
    const json = toJson(input, request);

    record(method, json, context);
    for await (const item of fake(json, context)) {
      yield encode(output, item, runtimeOneofs);
    }
  };

/** The lease states `runtime.lease/v1` reports as a failure with `leaseStatus`. */
const failedLeaseStates = new Set(['missing', 'pending', 'expired']);

/** A `runtime.lease/v1` failure carrying `leaseStatus`, as `runOnProjectLease` reads it. */
export const leaseFailure = (leaseStatus: string): ContractError =>
  new ContractError('unavailable', `The lease is ${leaseStatus}.`, {
    leaseStatus,
  });

/**
 * The generated-service fakes of `fakes` (the kinds `secrets/v1` answers
 * default to the built-in ones and GIT, as `./host.ts` does). Only the
 * services `fakes` names are served, plus `secrets/v1` always.
 */
export const routerFakes = (
  record: Recorder,
  fakes: Fakes = {},
  streams: Streams = {},
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
        project: unary(
          record,
          'resources',
          fake,
          'project',
          undefined,
          none,
          ProjectResourcesResponseSchema,
          asIs,
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

  if (
    fakes.runtime !== undefined ||
    streams.runtimeWatchProject !== undefined
  ) {
    const fake = fakes.runtime ?? {};
    const method = <O extends DescMessage>(
      name: string,
      input: DescMessage,
      args: (request: Json) => readonly unknown[],
      output: O,
      wrap: (value: unknown) => unknown,
    ) => unary(record, 'runtime', fake, name, input, args, output, wrap);
    const project = (value: unknown) => ({ project: value });

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
        createProject: method(
          'createProject',
          CreateProjectRequestSchema,
          whole,
          CreateProjectResponseSchema,
          project,
        ),
        project: method(
          'project',
          ProjectRequestSchema,
          byId,
          ProjectResponseSchema,
          project,
        ),
        projects: method(
          'projects',
          ProjectsRequestSchema,
          whole,
          ProjectsResponseSchema,
          asIs,
        ),
        renameProject: method(
          'renameProject',
          RenameProjectRequestSchema,
          whole,
          RenameProjectResponseSchema,
          project,
        ),
        setProjectColor: method(
          'setProjectColor',
          SetProjectColorRequestSchema,
          // The kernel passes an absent colour as `null`.
          (request) => [{ id: request.id, color: request.color ?? null }],
          SetProjectColorResponseSchema,
          project,
        ),
        terminateProject: method(
          'terminateProject',
          TerminateProjectRequestSchema,
          byId,
          TerminateProjectResponseSchema,
          project,
        ),
        deleteProject: method(
          'deleteProject',
          DeleteProjectRequestSchema,
          byId,
          DeleteProjectResponseSchema,
          (value) => ({ deleteResult: value }),
        ),
        ...(streams.runtimeWatchProject === undefined
          ? {}
          : {
              watchProject: stream(
                record,
                'runtime.watchProject',
                WatchProjectRequestSchema,
                WatchProjectResponseSchema,
                streams.runtimeWatchProject,
              ),
            }),
      }),
    );
  }

  if (fakes.threads !== undefined || streams.watchThread !== undefined) {
    const fake = fakes.threads ?? {};
    const method = <O extends DescMessage>(
      name: string,
      input: DescMessage,
      args: (request: Json) => readonly unknown[],
      output: O,
      wrap: (value: unknown) => unknown,
    ) => unary(record, 'threads', fake, name, input, args, output, wrap);
    const thread = (value: unknown) => ({ thread: value });

    entries.push(
      fakeOf(ThreadsService, {
        createThread: method(
          'createThread',
          CreateThreadRequestSchema,
          whole,
          CreateThreadResponseSchema,
          asIs,
        ),
        thread: method(
          'thread',
          ThreadRequestSchema,
          byId,
          ThreadResponseSchema,
          thread,
        ),
        threads: method(
          'threads',
          ThreadsRequestSchema,
          whole,
          ThreadsResponseSchema,
          (value) => ({ threadPage: value }),
        ),
        renameThread: method(
          'renameThread',
          RenameThreadRequestSchema,
          whole,
          RenameThreadResponseSchema,
          thread,
        ),
        setThreadCwd: method(
          'setThreadCwd',
          SetThreadCwdRequestSchema,
          whole,
          SetThreadCwdResponseSchema,
          asIs,
        ),
        setThreadExecution: method(
          'setThreadExecution',
          SetThreadExecutionRequestSchema,
          whole,
          SetThreadExecutionResponseSchema,
          asIs,
        ),
        prompt: method(
          'prompt',
          PromptRequestSchema,
          whole,
          PromptResponseSchema,
          (value) => ({ promptResult: value }),
        ),
        steer: method(
          'steer',
          SteerRequestSchema,
          whole,
          SteerResponseSchema,
          (value) => ({ steerResult: value }),
        ),
        resume: method(
          'resume',
          ResumeRequestSchema,
          idAndPrompt,
          ResumeResponseSchema,
          (value) => ({ resumeResult: value }),
        ),
        rewind: method(
          'rewind',
          RewindRequestSchema,
          whole,
          RewindResponseSchema,
          asIs,
        ),
        compact: method(
          'compact',
          CompactRequestSchema,
          (request) => [{ id: request.id }],
          CompactResponseSchema,
          asIs,
        ),
        threadEvents: method(
          'threadEvents',
          ThreadEventsRequestSchema,
          whole,
          ThreadEventsResponseSchema,
          (value) => ({ threadEventLog: value }),
        ),
        pause: method(
          'pause',
          PauseRequestSchema,
          idAndPrompt,
          PauseResponseSchema,
          (value) => ({ interruptResult: value }),
        ),
        terminateThread: method(
          'terminateThread',
          TerminateThreadRequestSchema,
          byId,
          TerminateThreadResponseSchema,
          thread,
        ),
        deleteThread: method(
          'deleteThread',
          DeleteThreadRequestSchema,
          byId,
          DeleteThreadResponseSchema,
          (value) => ({ deleteResult: value }),
        ),
        queue: method(
          'queue',
          QueueRequestSchema,
          byId,
          QueueResponseSchema,
          (value) => ({ threadQueue: value }),
        ),
        resumeQueue: method(
          'resumeQueue',
          ResumeQueueRequestSchema,
          byId,
          ResumeQueueResponseSchema,
          (value) => ({ resumeResult: value }),
        ),
        queuedPrompt: method(
          'queuedPrompt',
          QueuedPromptRequestSchema,
          idAndPrompt,
          QueuedPromptResponseSchema,
          (value) => ({ queuedPrompt: value }),
        ),
        editQueued: method(
          'editQueued',
          EditQueuedRequestSchema,
          whole,
          EditQueuedResponseSchema,
          asIs,
        ),
        removeQueued: method(
          'removeQueued',
          RemoveQueuedRequestSchema,
          idAndPrompt,
          RemoveQueuedResponseSchema,
          (value) => ({ removeQueuedResult: value }),
        ),
        ...(streams.watchThread === undefined
          ? {}
          : {
              watchThread: stream(
                record,
                'threads.watchThread',
                WatchThreadRequestSchema,
                WatchThreadResponseSchema,
                streams.watchThread,
              ),
            }),
      }),
    );
  }

  if (fakes.lease !== undefined) {
    const fake = fakes.lease;
    /** The kernel's `lease(scope).ssh()` answer, read once per call. */
    const sshOf = async (
      name: string,
      request: JsonValue,
      context: HandlerContext,
    ): Promise<{ status?: string; vmId?: string; ssh?: unknown }> => {
      record(`lease.${name}`, request, context);
      const domain = fake.ssh;

      if (domain === undefined) throw new Error('Unexpected lease ssh.');

      return (await domain(callOf(context))) as {
        status?: string;
        vmId?: string;
        ssh?: unknown;
      };
    };

    // The kernel's one `ssh()` answer as the two routed calls: `Describe`
    // fails with the lease state `leaseStatus` for missing, pending and
    // expired; `Ssh` answers no access for `unavailable`.
    entries.push(
      fakeOf(LeaseService, {
        describe: async (request, context) => {
          const access = await sshOf(
            'describe',
            toJson(DescribeRequestSchema, request),
            context,
          );

          if (failedLeaseStates.has(access.status ?? '')) {
            throw leaseFailure(access.status ?? '');
          }

          return encode(DescribeResponseSchema, {
            id: 'sandbox-1',
            root: '/workspace',
          });
        },
        ssh: async (request, context) => {
          const access = await sshOf(
            'ssh',
            toJson(SshRequestSchema, request),
            context,
          );

          return encode(
            SshResponseSchema,
            access.status === 'ready'
              ? { vmId: access.vmId, response: access.ssh }
              : { vmId: access.vmId ?? '' },
          );
        },
      }),
    );
  }

  if (fakes.files !== undefined) {
    const fake = fakes.files;

    entries.push(
      fakeOf(FilesService, {
        directory: unary(
          record,
          'files',
          fake,
          'directory',
          DirectoryRequestSchema,
          whole,
          DirectoryResponseSchema,
          asIs,
        ),
        tree: unary(
          record,
          'files',
          fake,
          'tree',
          TreeRequestSchema,
          whole,
          TreeResponseSchema,
          asIs,
        ),
        content: unary(
          record,
          'files',
          fake,
          'content',
          ContentRequestSchema,
          whole,
          ContentResponseSchema,
          asIs,
        ),
      }),
    );
  }

  if (fakes.git !== undefined) {
    const fake = fakes.git;
    const method = <O extends DescMessage>(
      name: string,
      input: DescMessage,
      args: (request: Json) => readonly unknown[],
      output: O,
    ) => unary(record, 'git', fake, name, input, args, output, asIs);

    entries.push(
      fakeOf(CommandsService, {
        status: method(
          'status',
          StatusRequestSchema,
          byThread,
          StatusResponseSchema,
        ),
        branches: method(
          'branches',
          BranchesRequestSchema,
          byThread,
          BranchesResponseSchema,
        ),
        switchBranch: method(
          'switchBranch',
          SwitchBranchRequestSchema,
          whole,
          SwitchBranchResponseSchema,
        ),
        diff: method('diff', DiffRequestSchema, whole, DiffResponseSchema),
        changes: method(
          'changes',
          ChangesRequestSchema,
          whole,
          ChangesResponseSchema,
        ),
        fileDiff: method(
          'fileDiff',
          FileDiffRequestSchema,
          whole,
          FileDiffResponseSchema,
        ),
      }),
    );
  }

  if (fakes.usage !== undefined) {
    const fake = fakes.usage;

    entries.push(
      fakeOf(UsageService, {
        thread: unary(
          record,
          'usage',
          fake,
          'thread',
          UsageThreadRequestSchema,
          byThread,
          UsageThreadResponseSchema,
          (value) => ({ threadUsage: value }),
        ),
      }),
    );
  }

  if (
    fakes.terminal !== undefined ||
    streams.terminalWatchProject !== undefined
  ) {
    const fake = fakes.terminal ?? {};

    entries.push(
      fakeOf(TerminalService, {
        list: unary(
          record,
          'terminal',
          fake,
          'list',
          TerminalListRequestSchema,
          (request) => [request.projectId],
          TerminalListResponseSchema,
          (value) => ({ terminals: value }),
        ),
        create: unary(
          record,
          'terminal',
          fake,
          'create',
          TerminalCreateRequestSchema,
          ({ threadId, ...size }) => [threadId, size],
          TerminalCreateResponseSchema,
          (value) => ({ terminalSession: value }),
        ),
        ...(streams.terminalWatchProject === undefined
          ? {}
          : {
              watchProject: stream(
                record,
                'terminal.watchProject',
                TerminalWatchProjectRequestSchema,
                TerminalWatchProjectResponseSchema,
                streams.terminalWatchProject,
              ),
            }),
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
