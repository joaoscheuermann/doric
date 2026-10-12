import {
  type AnyServiceDefinition,
  type CallScope,
  defineMethod,
  defineService,
  hooksMethods,
  type LogFields,
  LogV1,
  logMethods,
  modelsMethods,
  type Secret,
  SecretsV1,
  type Services,
  type StorageHealth,
  storageMethods,
  toLanguageModel,
} from 'bundle/contracts';
import { createTestServices } from 'bundle/testing';
import { ConfigurationV1, configurationMethods } from 'host-config/contracts';
import type { Sandbox } from 'sandbox';
import type { SandboxLease } from 'sandpool';
import {
  type TerminalService,
  TerminalServiceV1,
  TerminalV1,
} from 'terminal/contracts';
import { createTerminalHost, type TerminalHost } from 'terminal/host';
import { z } from 'zod';

import type {
  ConfigurationValue,
  DoricConfiguration,
} from '../../../src/contracts/configuration.js';
import type { RuntimeLease } from '../../../src/contracts/lease.js';
import {
  RuntimeLeaseV1,
  runtimeLeaseMethods,
} from '../../../src/contracts/lease.js';
import type { ProjectColor } from '../../../src/contracts/model.js';
import {
  type Runtime,
  type RuntimeNotice,
  type RuntimeOwner,
  RuntimeV1,
} from '../../../src/contracts/runtime.js';
import { readRuntimeScope } from '../../../src/contracts/scope.js';
import {
  type RuntimeTerminals,
  RuntimeTerminalsV1,
} from '../../../src/contracts/terminals.js';
import {
  type RuntimeThreads,
  RuntimeThreadsV1,
} from '../../../src/contracts/threads.js';
import {
  type RuntimeUsage,
  RuntimeUsageV1,
} from '../../../src/contracts/usage.js';
import {
  type RuntimeWorkspace,
  RuntimeWorkspaceV1,
} from '../../../src/contracts/workspace.js';
import { createBindings } from '../../../src/host/domain/bindings.js';
import type { WorkspaceService } from '../../../src/host/domain/types.js';
import type { ModelCatalogSource } from '../../../src/host/domain/usage-context.js';
import { provideRuntime, runtimeStores } from '../../../src/host/index.js';
import {
  type ProjectResourcesReader,
  ResourcesV1,
} from '../../../src/host/peers.js';
import { createPorts } from '../../../src/host/ports.js';
import type {
  ProjectStore,
  ThreadStore,
} from '../../../src/host/store/types.js';
import { type Backend, memoryBackend } from '../../store/support.js';
import { complete, secretsProvider } from '../../support/credentials.js';
import {
  executorProvider,
  type Script,
  type ScriptedExecutorOptions,
  type ScriptedRun,
} from '../../support/executor.js';
import {
  type SandboxProviderOptions,
  type SandboxRecord,
  sandboxProvider,
} from '../../support/sandbox.js';

/*
 * The runtime host part over the real store (memory storage by default),
 * with fakes only at the contracts the runtime requires: host-config/v1,
 * secrets/v1, sandbox/v1, models/v1, log/v1, hooks/v1, storage/v1 health and
 * a scripted executor/v1. Every case reaches the runtime through its own
 * contracts, from a consumer bundle, the way the transport and the tools do.
 */

export const epoch = new Date(0).toISOString();

/** The configuration a host starts with (agents/doric `defaultConfig`). */
export const defaultConfiguration: ConfigurationValue = {
  providers: [
    {
      id: 'openrouter',
      kind: 'openrouter',
      configuration: {
        endpoint: 'https://openrouter.ai/api/v1',
        token: '00000000-0000-4000-8000-000000000002',
      },
      models: [],
    },
  ],
  models: {
    execution: {
      providerId: 'openrouter',
      model: 'deepseek/deepseek-v4-flash-0731',
      effort: 'low',
    },
  },
  execution: { maxTurns: 32 },
  tools: {},
};

/** Every llms kind names its credential in a `secret` field called `token`. */
const kind = (id: string) => ({
  id,
  label: id,
  description: id,
  fields: [
    {
      key: 'token',
      label: 'Token',
      kind: 'secret' as const,
      required: id !== 'openai',
    },
  ],
  lists: ['models' as const, 'reasonings' as const],
});

export const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

/** What a scripted run can reach, as a tool reaches it: the runtime contracts. */
export interface ToolHost {
  readonly threads: RuntimeThreads;
  readonly workspace: RuntimeWorkspace;
  readonly lease: RuntimeLease;
  readonly terminal: {
    run(input: unknown, call?: { signal?: AbortSignal }): Promise<unknown>;
  };
}

export type HarnessRun = ScriptedRun & { readonly tools: ToolHost };

export interface HarnessOptions {
  /** One prompt run; finishes with 'done' by default. */
  readonly execute?: (run: HarnessRun) => Promise<string>;
  readonly executor?: ScriptedExecutorOptions;
  readonly sandbox?: SandboxProviderOptions;
  /** The configuration in force, read on every call. */
  readonly configuration?: () => DoricConfiguration;
  readonly credentials?: () => readonly Secret[];
  /** storage/v1.health(); a healthy disk by default. */
  readonly health?: () => Promise<StorageHealth>;
  /** The llms provider models/v1 resolves for each provider id. */
  readonly models?: Readonly<Record<string, ModelCatalogSource>>;
  readonly backend?: Backend;
  /**
   * This runtime process as doric.generation/v1 describes it (57-WP-H); a
   * host without generations by default, which records no Project owner.
   */
  readonly generation?: () => Promise<RuntimeOwner | undefined>;
}

export interface LogEntry {
  readonly level: string;
  readonly message: string;
  readonly fields?: LogFields;
}

const overridable = <T extends object>(target: T): T =>
  Object.fromEntries(
    Object.entries(target).map(([key, value]) => [
      key,
      typeof value === 'function' ? value.bind(target) : value,
    ]),
  ) as T;

export const waitUntil = async (
  check: () => boolean | Promise<boolean>,
  what = 'a condition',
): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((done) => setTimeout(done, 2));
  }
};

export const createHarness = (options: HarnessOptions = {}) => {
  const backend = options.backend ?? memoryBackend();
  const logs: LogEntry[] = [];
  const hooks: { readonly hook: string; readonly input: unknown }[] = [];
  const configuration =
    options.configuration ??
    (() => ({
      configuration: defaultConfiguration,
      revision: 1,
      updatedAt: epoch,
    }));
  const sandbox = sandboxProvider(options.sandbox);
  let consumer: Services | undefined;
  let terminalHost: TerminalHost | undefined;
  const consumed = (): Services => {
    if (consumer === undefined) throw new Error('The harness is not ready.');
    return consumer;
  };
  const toolsFor = (scope: CallScope): ToolHost => {
    if (consumer === undefined) throw new Error('The harness is not ready.');
    return {
      threads: consumer.use(RuntimeThreadsV1, scope),
      workspace: consumer.use(RuntimeWorkspaceV1, scope),
      lease: consumer.use(RuntimeLeaseV1, scope),
      terminal: consumer.use(
        TerminalV1,
        scope,
      ) as unknown as ToolHost['terminal'],
    };
  };
  const script: Script = (run) =>
    (options.execute ?? (async () => 'done'))({
      ...run,
      tools: toolsFor(run.scope),
    });
  const log = (level: string) =>
    defineMethod({
      ...logMethods[level as 'info'],
      execute: ([message, fields]) => {
        logs.push({
          level,
          message,
          ...(fields === undefined ? {} : { fields }),
        });
      },
    });
  const fakes: AnyServiceDefinition[] = [
    defineService(ConfigurationV1.id, {
      current: defineMethod({
        ...configurationMethods.current,
        execute: async () => configuration(),
      }),
    }),
    secretsProvider(options.credentials),
    sandbox.definition,
    defineService(
      'storage/v1',
      complete(storageMethods, {
        health: defineMethod({
          ...storageMethods.health,
          execute: () =>
            options.health?.() ??
            Promise.resolve({
              status: 'ok' as const,
              writable: true,
              disk: { blocks: 100, availableBlocks: 50 },
            }),
        }),
      }),
    ),
    defineService(
      'models/v1',
      complete(modelsMethods, {
        kind: defineMethod({
          ...modelsMethods.kind,
          execute: async ([id]) =>
            ['openai', 'openrouter', 'codex'].includes(id)
              ? kind(id)
              : undefined,
        }),
        resolve: defineMethod({
          ...modelsMethods.resolve,
          execute: async ({ providerId, model, effort }) => {
            const source = options.models?.[providerId];
            if (source === undefined)
              throw new Error('Configured provider is unavailable.');
            return {
              providerId,
              model,
              ...(effort === undefined ? {} : { effort }),
              languageModel: toLanguageModel(source),
            };
          },
        }),
      }),
    ),
    defineService('log/v1', {
      debug: log('debug'),
      info: log('info'),
      warn: log('warn'),
      error: log('error'),
    }),
    defineService('hooks/v1', {
      define: defineMethod({
        ...hooksMethods.define,
        execute: () => ({ dispose: () => undefined }),
      }),
      register: defineMethod({
        ...hooksMethods.register,
        execute: () => ({ dispose: () => undefined }),
      }),
      whenDefined: defineMethod({
        ...hooksMethods.whenDefined,
        execute: () => ({ dispose: () => undefined }),
      }),
      execute: defineMethod({
        ...hooksMethods.execute,
        execute: async ([, hook, input]) => {
          hooks.push({ hook, input });
          // The terminal bundle's handler, as its activation registers it.
          if (hook === 'onThreadsClosingHook')
            await terminalHost?.threadsClosing(
              input as Parameters<TerminalHost['threadsClosing']>[0],
            );
          return undefined;
        },
      }),
    }),
    executorProvider(script, options.executor),
  ];
  const runtimeSide = createTestServices({
    bundle: { id: 'runtime' },
    provide: fakes,
  });
  const ports = {
    ...createPorts(runtimeSide.services),
    ...(options.generation === undefined
      ? {}
      : { generation: options.generation }),
  };
  const real = runtimeStores(backend.storage, ports);
  /** The stores the runtime uses; a case may replace one method to observe it. */
  const projects: ProjectStore = overridable(real.projects);
  const threads: ThreadStore = overridable(real.threads);
  const definitions: AnyServiceDefinition[] = [];
  const bindings = createBindings();
  const { cleanup } = provideRuntime(
    {
      provide: (definition) => {
        definitions.push(definition);
        return { dispose: () => undefined };
      },
    },
    {
      projects,
      threads,
      ports,
      bindings,
      terminal: (): TerminalService => consumed().use(TerminalServiceV1),
      resources: (): ProjectResourcesReader => consumed().use(ResourcesV1),
    },
  );
  // The terminal sessions are the `terminal` bundle's (stage 10 host
  // switch): its real host part, over the runtime contracts.
  terminalHost = createTerminalHost({
    secrets: runtimeSide.services.use(SecretsV1),
    workspace: () => consumed().use(RuntimeWorkspaceV1),
    threads: () => consumed().use(RuntimeThreadsV1),
    log: () => runtimeSide.services.use(LogV1),
  });
  definitions.push(terminalHost.definition);
  // resources/v1 as the `resources` bundle answers it: the calling Project's
  // container on the lease it holds now, read through runtime.lease/v1.
  const resourceReads: (string | undefined)[] = [];
  definitions.push(
    defineService(ResourcesV1, {
      project: defineMethod({
        input: runtimeLeaseMethods.resources.input,
        output: z.any(),
        execute: (_input, call, services) => {
          resourceReads.push(readRuntimeScope(call).projectId);
          return services
            .use(RuntimeLeaseV1, call.scope)
            .withLease(async (sandbox) => {
              const stats = await sandbox.stats?.();
              return {
                ...stats,
                status: stats === undefined ? 'unavailable' : 'ready',
                at: epoch,
              } as const;
            });
        },
      }),
    }),
  );
  const consumerSide = createTestServices({
    bundle: { id: 'consumer' },
    provide: definitions,
  });
  consumer = consumerSide.services;
  const runtime: Runtime = consumer.use(RuntimeV1);
  const threadsApi: RuntimeThreads = consumer.use(RuntimeThreadsV1);
  const terminals: RuntimeTerminals = consumer.use(RuntimeTerminalsV1);
  const workspace: RuntimeWorkspace = consumer.use(RuntimeWorkspaceV1);
  const usage: RuntimeUsage = consumer.use(RuntimeUsageV1);
  const notices: RuntimeNotice[] = [];
  const listeners = new Set<(notice: RuntimeNotice) => void>();
  runtime.watch((notice) => {
    notices.push(notice);
    for (const listener of listeners) listener(notice);
  });
  const leaseOf = (scope: CallScope): RuntimeLease =>
    (consumer as Services).use(RuntimeLeaseV1, scope);
  /** The WorkspaceService operations, each through the runtime contracts. */
  const service: WorkspaceService = {
    projects: {
      create: (name) => runtime.createProject({ name }),
      find: (id) => runtime.project(id),
      list: (limit, cursor) =>
        runtime.projects({
          limit,
          ...(cursor === undefined ? {} : { cursor }),
        }),
      rename: (id, name) => runtime.renameProject({ id, name }),
      setColor: (id, color: ProjectColor | undefined) =>
        runtime.setProjectColor({ id, color: color ?? null }),
      terminate: (id) => runtime.terminateProject(id),
      delete: (id) => runtime.deleteProject(id),
      ssh: (id) => leaseOf({ projectId: id }).ssh(),
      files: (id, path) =>
        leaseOf({ projectId: id }).files(path === undefined ? {} : { path }),
      file: (id, path) => leaseOf({ projectId: id }).file({ path }),
      tree: (id, path) =>
        leaseOf({ projectId: id }).tree(path === undefined ? {} : { path }),
      diff: (id, path) =>
        leaseOf({ projectId: id }).diff(path === undefined ? {} : { path }),
      changes: (id, path) =>
        leaseOf({ projectId: id }).changes(path === undefined ? {} : { path }),
      fileDiff: (id, repository, path) =>
        leaseOf({ projectId: id }).fileDiff({ repository, path }),
      resources: (id) => leaseOf({ projectId: id }).resources(),
      withLease: (id, task) => leaseOf({ projectId: id }).withLease(task),
    },
    threads: {
      queue: (id) => threadsApi.queue(id),
      resumeQueue: (id) => threadsApi.resumeQueue(id),
      queuedPrompt: (id, promptId) => threadsApi.queuedPrompt({ id, promptId }),
      editQueued: (id, promptId, text, revision) =>
        threadsApi.editQueued({ id, promptId, text, revision }),
      removeQueued: (id, promptId) => threadsApi.removeQueued({ id, promptId }),
      usage: (id) => threadsApi.usage(id),
      storedUsage: (id) => usage.read(id),
      withThread: (id, options, task) =>
        workspace.withThread(id, options, task),
      terminalResult: (input) => threadsApi.enqueueTerminalResult(input),
      failTerminalResult: (threadId) =>
        threadsApi.failTerminalResult({ threadId }),
      create: (projectId, name, parentThreadId) =>
        threadsApi.createThread({
          projectId,
          name,
          ...(parentThreadId === undefined ? {} : { parentThreadId }),
        }),
      find: (id) => threadsApi.thread(id),
      list: (projectId, limit, cursor, parentThreadId) =>
        threadsApi.threads({
          projectId,
          limit,
          ...(cursor === undefined ? {} : { cursor }),
          ...(parentThreadId === undefined ? {} : { parentThreadId }),
        }),
      rename: (id, name) => threadsApi.renameThread({ id, name }),
      setCwd: (id, cwd) => threadsApi.setThreadCwd({ id, cwd }),
      git: (id) => leaseOf({ threadId: id }).git(),
      branches: (id, branch, cwd) =>
        leaseOf({ threadId: id }).branches({
          ...(branch === undefined ? {} : { branch }),
          ...(cwd === undefined ? {} : { cwd }),
        }),
      prompt: (id, prompt) => threadsApi.prompt({ id, prompt }),
      resume: (id, promptId) => threadsApi.resume({ id, promptId }),
      rewind: (id, promptId, prompt) =>
        threadsApi.rewind({ id, promptId, prompt }),
      events: (id, afterSequence) =>
        threadsApi.threadEvents({ id, afterSequence }),
      interrupt: (id, promptId) => threadsApi.pause({ id, promptId }),
      terminate: (id) => threadsApi.terminateThread(id),
      delete: (id) => threadsApi.deleteThread(id),
    },
    resumeInterrupted: async () => (await runtime.recover()).resumedPrompts,
    // recover() schedules the Project recovery after the resume.
    recoverProjects: async () => {
      await runtime.recover();
    },
    sshForVm: (id) => runtime.vmSsh(id),
    dispose: () => runtime.dispose(),
    handover: {
      begin: () => {
        throw new Error('Use runtime.recoverWith through the contract.');
      },
      adopt: (live) => runtime.adopt({ live }),
      drain: (released) => runtime.drain(released),
    },
  };
  const projectState = (id: string, state: string) =>
    waitUntil(
      async () => (await projects.record(id))?.state === state,
      `Project ${id} ${state}`,
    );
  const threadState = (id: string, state: string) =>
    waitUntil(
      async () => (await threads.record(id))?.state === state,
      `Thread ${id} ${state}`,
    );

  return {
    service,
    runtime,
    threads: threadsApi,
    terminals,
    /** The `terminal` bundle's terminal/v1, which owns the sessions. */
    terminal: consumer.use(TerminalServiceV1),
    /** The Project of every resources/v1 `project` read, in order. */
    resourceReads,
    lease: leaseOf,
    stores: { projects, threads },
    notices,
    /** Observes every notice from now on, synchronously. */
    listen: (listener: (notice: RuntimeNotice) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    events: () =>
      notices.flatMap((notice) =>
        notice.kind === 'event' ? [notice.value] : [],
      ),
    logs,
    hooks,
    /** The runtime's prompt bindings. */
    bindings,
    /** The consumer bundle the cases call the runtime contracts from. */
    consumer: consumerSide,
    sandbox: sandbox.record as SandboxRecord,
    projectState,
    threadState,
    waitFor: waitUntil,
    /** Creates a Project and waits until its sandbox is leased. */
    readyProject: async (name = 'Project') => {
      const project = await runtime.createProject({ name });
      await projectState(project.id, 'ready');
      return project;
    },
    createThread: async (projectId: string, parentThreadId?: string) => {
      const result = await service.threads.create(
        projectId,
        'Thread',
        parentThreadId,
      );
      if (result.status !== 'created')
        throw new Error(`Thread creation failed: ${result.status}`);
      return result.thread;
    },
    dispose: async () => {
      await runtime.dispose();
      await cleanup();
      terminalHost?.dispose();
      await consumerSide.dispose();
      await runtimeSide.dispose();
      if (options.backend === undefined) await backend.close();
    },
  };
};

export type Harness = ReturnType<typeof createHarness>;

/** A lease over a sandbox, released through `release`. */
export const leaseOver = (
  sandbox: Sandbox,
  release: () => Promise<void> = async () => undefined,
): SandboxLease => ({ sandbox, release }) as unknown as SandboxLease;
