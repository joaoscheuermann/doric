// The world an `mcp` test runs in: the host part activated beside fakes of
// every contract it requires, each standing for a real boundary — storage/v1
// over the in-memory backend, a recording secrets/v1, a recording tools/v1, a
// hooks/v1 whose runtime hooks the test fires, runtime/v1 notices the test
// publishes, a runtime.lease/v1 over a fake sandbox, and a recording
// runtime.attachments/v1. An Environment holds what outlives one activation
// (storage, credentials, sandbox), so a test can activate the bundle again.

import { createHash, randomUUID } from 'node:crypto';

import {
  type AnyServiceDefinition,
  builtinCredentialKinds,
  type Call,
  type CommitBatch,
  ContractError,
  type ContractTool,
  type CredentialCreate,
  type CredentialDescription,
  type CredentialKindDefinition,
  type CredentialRef,
  type CredentialUpdate,
  type Disposable,
  defineMethod,
  defineService,
  type HooksContract,
  HooksV1,
  hooksMethods,
  LogV1,
  logMethods,
  type Secret,
  SecretsV1,
  type StorageBackend,
  StorageBackendV1,
  type StorageTypeDefinition,
  StorageV1,
  secretsMethods,
  storageMethods,
  type ToolRegistrationOptions,
  ToolsV1,
  toolsMethods,
} from 'bundle/contracts';
import { createTestServices, type TestServices } from 'bundle/testing';
import {
  type AttachInput,
  type Attachment,
  RuntimeAttachmentsV1,
  RuntimeLeaseV1,
  type RuntimeListener,
  type RuntimeNotice,
  RuntimeV1,
  runtimeAttachmentsMethods,
  runtimeLeaseMethods,
  runtimeMethods,
} from 'runtime/contracts';
import type { Sandbox } from 'sandbox';
import {
  createMemoryStore,
  type MemoryStore,
  memoryStorageBackend,
} from 'storage/memory';
import type { z } from 'zod';

import {
  type Mcp,
  type McpEntry,
  type McpServerInput,
  type McpServerView,
  McpV1,
} from '../../src/contracts/index.js';
import { activate } from '../../src/host/index.js';
import {
  type FakeSandbox,
  type FakeSandboxOptions,
  fakeSandbox,
} from './sandbox.js';
import { eventually, WAIT_MS } from './wait.js';

/** The storage type the bundle keeps its servers in (src/host/store.ts). */
export const SERVER_TYPE = 'mcp.server/v1';

/** Two Projects, by the UUIDs the runtime gives Projects. */
export const P1 = '11111111-1111-4111-8111-111111111111';
export const P2 = '22222222-2222-4222-8222-222222222222';

type Handler = (input: never, call: Call) => unknown;

type Specs = Readonly<
  Record<string, { readonly input: z.ZodType; readonly output: z.ZodType }>
>;

/** The refusal of a method the world was not given an answer for. */
const unanswered = (name: string) => (): never => {
  throw new Error(`The world was not given an answer for ${name}.`);
};

/** A provider of every method of a contract; the unlisted ones refuse. */
const fake = (
  id: string,
  specs: Specs,
  handlers: Readonly<Record<string, Handler>>,
): AnyServiceDefinition =>
  defineService(
    id as `${string}/v${number}`,
    Object.fromEntries(
      Object.entries(specs).map(([name, spec]) => [
        name,
        defineMethod({
          input: spec.input,
          output: spec.output,
          execute: (input: unknown, call: Call) =>
            (handlers[name] ?? unanswered(`${id} ${name}`))(
              input as never,
              call,
            ),
        }),
      ]),
    ),
  );

const once = (dispose: () => void): Disposable => {
  let done = false;

  return {
    dispose: () => {
      if (!done) {
        done = true;
        dispose();
      }
    },
  };
};

/** What the fake secrets/v1 was asked, in call order. */
export interface SecretCalls {
  readonly resolved: string[];
  readonly created: CredentialCreate[];
  readonly updated: { readonly id: string; readonly input: CredentialUpdate }[];
  readonly deleted: string[];
  readonly kinds: CredentialKindDefinition[];
}

export type LeaseStatus =
  | 'ready'
  | 'pending'
  | 'unavailable'
  | 'expired'
  | 'missing';

/** What outlives one activation: storage, credentials, the sandbox, the lease. */
export interface Environment {
  readonly store: MemoryStore;
  /** The credential store behind secrets/v1, by id. */
  readonly credentials: Map<string, Secret>;
  readonly secretCalls: SecretCalls;
  readonly sandbox: FakeSandbox;
  /** What runtime.lease/v1.withLease answers; `ready` runs the task. */
  lease: LeaseStatus;
  /** The Project of each withLease call, in order. */
  readonly leased: string[];
  /** Stores an API_TOKEN credential and answers its id. */
  addCredential(name: string, secret?: string): string;
  credentialNamed(name: string): Secret | undefined;
  /** Every stored server document, as storage keeps it. */
  serverDocuments(): readonly unknown[];
}

export const createEnvironment = (
  options: { readonly sandbox?: FakeSandboxOptions } = {},
): Environment => {
  const store = createMemoryStore();
  const credentials = new Map<string, Secret>();

  return {
    store,
    credentials,
    secretCalls: {
      resolved: [],
      created: [],
      updated: [],
      deleted: [],
      kinds: [],
    },
    sandbox: fakeSandbox(options.sandbox),
    lease: 'ready',
    leased: [],
    addCredential: (name, secret) => {
      const id = randomUUID();
      credentials.set(id, {
        id,
        kind: 'API_TOKEN',
        name,
        ...(secret === undefined ? {} : { secret }),
      });

      return id;
    },
    credentialNamed: (name) =>
      [...credentials.values()].find((entry) => entry.name === name),
    serverDocuments: () =>
      [...(store.documents.get(SERVER_TYPE)?.values() ?? [])].map(
        (document) => document.value,
      ),
  };
};

const describeCredential = (secret: Secret): CredentialDescription => ({
  id: secret.id,
  kind: secret.kind,
  name: secret.name,
  ...(secret.username === undefined ? {} : { username: secret.username }),
  ...(secret.email === undefined ? {} : { email: secret.email }),
  hasSecret: secret.secret !== undefined && secret.secret !== '',
});

const missing = (id: string) =>
  new ContractError('credential_missing', `Credential ${id} is not stored.`);

/** secrets/v1 over the environment's credentials, recording every write. */
const secretsService = (env: Environment): AnyServiceDefinition => {
  const { credentials, secretCalls } = env;

  return fake(SecretsV1.id, secretsMethods, {
    resolve: (ref: CredentialRef) => {
      secretCalls.resolved.push(ref.id);
      const found = credentials.get(ref.id);

      if (found === undefined) {
        throw missing(ref.id);
      }

      return Promise.resolve(found);
    },
    list: () =>
      Promise.resolve([...credentials.values()].map(describeCredential)),
    kinds: () =>
      Promise.resolve([...builtinCredentialKinds, ...secretCalls.kinds]),
    registerKind: (definition: CredentialKindDefinition) => {
      if (
        [...builtinCredentialKinds, ...secretCalls.kinds].some(
          (kind) => kind.id === definition.id,
        )
      ) {
        throw new ContractError(
          'duplicate_credential_kind',
          `Kind ${definition.id} is taken.`,
        );
      }

      secretCalls.kinds.push(definition);

      return once(() => {
        secretCalls.kinds.splice(secretCalls.kinds.indexOf(definition), 1);
      });
    },
    describe: (ref: CredentialRef) => {
      const found = credentials.get(ref.id);

      return Promise.resolve(
        found === undefined ? undefined : describeCredential(found),
      );
    },
    create: (input: CredentialCreate) => {
      secretCalls.created.push(input);

      if (
        [...credentials.values()].some(
          (entry) => entry.kind === input.kind && entry.name === input.name,
        )
      ) {
        throw new ContractError(
          'credential_name_taken',
          `A ${input.kind} credential named ${input.name} is stored.`,
        );
      }

      const id = randomUUID();
      const stored: Secret = { id, ...input };
      credentials.set(id, stored);

      return Promise.resolve(describeCredential(stored));
    },
    update: ([ref, input]: [CredentialRef, CredentialUpdate]) => {
      secretCalls.updated.push({ id: ref.id, input });
      const found = credentials.get(ref.id);

      if (found === undefined) {
        throw missing(ref.id);
      }

      const next: Secret = {
        ...found,
        ...(input.kind === undefined ? {} : { kind: input.kind }),
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.secret === undefined || input.secret === null
          ? {}
          : { secret: input.secret }),
      };
      credentials.set(ref.id, next);

      return Promise.resolve(describeCredential(next));
    },
    delete: (ref: CredentialRef) => {
      secretCalls.deleted.push(ref.id);

      return Promise.resolve(
        credentials.delete(ref.id) ? 'deleted' : 'missing',
      );
    },
    resolveByKind: () => Promise.resolve(undefined),
    redactions: () =>
      Promise.resolve(
        [...credentials.values()].flatMap((entry) =>
          entry.secret === undefined ? [] : [entry.secret],
        ),
      ),
    watchRedactions: () => once(() => undefined),
    registerReferences: () => once(() => undefined),
  });
};

/**
 * storage/v1 over a backend, as the core facade serves it: a type is
 * declared before its first use and every put is validated against the
 * defined type's schema.
 */
const storageService = (backend: StorageBackend): AnyServiceDefinition => {
  const types = new Map<string, StorageTypeDefinition>();
  const declared = new Map<string, Promise<void>>();

  const ready = (type: string): Promise<void> => {
    const definition = types.get(type);

    if (definition === undefined) {
      throw new ContractError(
        'unknown_type',
        `Storage type ${type} is not defined.`,
      );
    }

    let pending = declared.get(type);

    if (pending === undefined) {
      pending = backend.declareType({
        type,
        indexes: definition.indexes.map(({ name, fields, unique }) => ({
          name,
          fields: [...fields],
          ...(unique === undefined ? {} : { unique }),
        })),
      });
      declared.set(type, pending);
    }

    return pending;
  };

  return fake(StorageV1.id, storageMethods, {
    defineType: (definition: StorageTypeDefinition) => {
      types.set(definition.type, definition);

      return once(() => undefined);
    },
    get: async (key: { readonly type: string; readonly id: string }) => {
      await ready(key.type);

      return backend.get(key);
    },
    query: async (query: Parameters<StorageBackend['query']>[0]) => {
      await ready(query.type);

      return backend.query(query);
    },
    read: (request: Parameters<StorageBackend['read']>[0]) =>
      backend.read(request),
    commit: async (batch: CommitBatch) => {
      for (const key of [
        ...(batch.expect ?? []),
        ...(batch.put ?? []),
        ...(batch.delete ?? []),
      ]) {
        await ready(key.type);
      }

      for (const put of batch.put ?? []) {
        const parsed = types.get(put.type)?.schema.safeParse(put.value);

        if (parsed?.success === false) {
          throw new ContractError(
            'invalid_input',
            `Invalid ${put.type} document: ${parsed.error.message}`,
          );
        }
      }

      return backend.commit(batch);
    },
    health: () => backend.health(),
    putBlob: (bytes: string) => backend.putBlob(bytes),
    getBlob: (hash: string) => backend.getBlob(hash),
    deleteBlob: (hash: string) => backend.deleteBlob(hash),
  });
};

/** One `tools/v1.register` call the fake registry received. */
export interface Registration {
  readonly tool: ContractTool;
  readonly options: ToolRegistrationOptions & { readonly projectId?: string };
  readonly disposed: boolean;
}

type RuntimeHook = 'onPromptStartedHook' | 'onProjectClosingHook';

/** One `log/v1.warn` call the fake log received. */
export interface LoggedWarning {
  readonly message: string;
  readonly fields?: unknown;
}

/** The world one activation of the bundle runs in. */
export interface World {
  readonly env: Environment;
  readonly test: TestServices;
  /** mcp/v1 as a window of the Project calls it. */
  mcp(projectId: string): Mcp;
  /** mcp/v1 called with no Project scope. */
  readonly unscoped: Mcp;
  readonly registrations: readonly Registration[];
  /** The registrations under the Project that are not disposed. */
  live(projectId: string): readonly Registration[];
  /** The live tool names under the Project, sorted. */
  liveNames(projectId: string): readonly string[];
  /** The live tool of that name under the Project. */
  tool(projectId: string, name: string): ContractTool;
  /** The Call of a running prompt of the Project. */
  promptCall(projectId: string, signal?: AbortSignal): Call;
  /** Fires runtime.hooks/v1.onPromptStartedHook and awaits its handlers. */
  promptStarted(projectId: string): Promise<void>;
  /** Fires runtime.hooks/v1.onProjectClosingHook and awaits its handlers. */
  projectClosing(projectId: string): Promise<void>;
  /** Publishes a runtime/v1 notice to every watcher. */
  notice(notice: RuntimeNotice): void;
  /** Images the bundle attached, in order. */
  readonly attached: readonly AttachInput[];
  /** The attachments the fake answered, in order. */
  readonly attachments: readonly Attachment[];
  /** The `log/v1` warnings the bundle logged, in order. */
  readonly warnings: readonly LoggedWarning[];
  /** Watches the Project until a snapshot satisfies `predicate`. */
  watchUntil(
    projectId: string,
    predicate: (servers: readonly McpServerView[]) => boolean,
    label: string,
  ): Promise<readonly McpServerView[]>;
  /** Polls `list` (which never connects) until it satisfies `predicate`. */
  listUntil(
    projectId: string,
    predicate: (servers: readonly McpServerView[]) => boolean,
    label: string,
  ): Promise<readonly McpServerView[]>;
  /** Runs the bundle's deactivation, as the platform would; idempotent. */
  deactivate(): Promise<void>;
}

/** Activates the bundle over the environment's fakes. */
export const activateWorld = async (
  env: Environment = createEnvironment(),
): Promise<World> => {
  const registrations: {
    tool: ContractTool;
    options: Registration['options'];
    disposed: boolean;
  }[] = [];
  const handlers: { hook: string; handler: Handler }[] = [];
  const listeners = new Set<RuntimeListener>();
  const attached: AttachInput[] = [];
  const attachments: Attachment[] = [];
  const warnings: LoggedWarning[] = [];

  const backendWorld = createTestServices({
    bundle: { id: 'mcp-storage' },
    provide: [memoryStorageBackend(env.store)],
  });

  const tools = fake(ToolsV1.id, toolsMethods, {
    register: ([tool, options]: [ContractTool, Registration['options']]) => {
      const entry = { tool, options, disposed: false };
      registrations.push(entry);

      return once(() => {
        entry.disposed = true;
      });
    },
    list: () => [],
    catalog: () => Promise.resolve([]),
  });

  const hooks = fake(HooksV1.id, hooksMethods, {
    define: () => once(() => undefined),
    register: ([contract, hook, handler]: [HooksContract, string, Handler]) => {
      const entry = { hook: `${contract.id}#${hook}`, handler };
      handlers.push(entry);

      return once(() => {
        handlers.splice(handlers.indexOf(entry), 1);
      });
    },
    // runtime.hooks/v1 is defined: a waiter runs at once.
    whenDefined: ([, callback]: [HooksContract, () => unknown]) => {
      const cleanup = callback();

      return once(() => {
        if (typeof cleanup === 'function') {
          void (cleanup as () => unknown)();
        }
      });
    },
  });

  const log = fake(LogV1.id, logMethods, {
    debug: () => undefined,
    info: () => undefined,
    warn: ([message, fields]: [string, unknown]) => {
      warnings.push({ message, fields });
    },
    error: () => undefined,
  });

  const runtime = fake(RuntimeV1.id, runtimeMethods, {
    watch: (listener: RuntimeListener) => {
      listeners.add(listener);

      return once(() => {
        listeners.delete(listener);
      });
    },
  });

  const lease = fake(RuntimeLeaseV1.id, runtimeLeaseMethods, {
    withLease: async (
      task: (sandbox: Sandbox) => Promise<unknown>,
      call: Call,
    ) => {
      env.leased.push(call.scope?.projectId ?? '');

      if (env.lease !== 'ready') {
        return { status: env.lease };
      }

      return { status: 'ready', value: await task(env.sandbox.sandbox) };
    },
  });

  const attachmentsService = fake(
    RuntimeAttachmentsV1.id,
    runtimeAttachmentsMethods,
    {
      attach: (input: AttachInput) => {
        attached.push(input);
        const bytes = Buffer.from(input.bytes, 'base64');
        const attachment: Attachment = {
          id: `sha256-${createHash('sha256').update(bytes).digest('hex')}`,
          name: input.name === '' ? 'image' : input.name,
          mediaType: 'image/png',
          size: Math.max(1, bytes.length),
        };
        attachments.push(attachment);

        return Promise.resolve(attachment);
      },
      read: () => Promise.resolve(undefined),
    },
  );

  const test = createTestServices({
    bundle: { id: 'mcp' },
    provide: [
      storageService(backendWorld.services.use(StorageBackendV1)),
      secretsService(env),
      tools,
      hooks,
      log,
      runtime,
      lease,
      attachmentsService,
    ],
  });

  let cleanup: unknown;

  try {
    cleanup = await activate({ services: test.services });
  } catch (error) {
    await test.dispose();
    await backendWorld.dispose();
    throw error;
  }

  let deactivated: Promise<void> | undefined;

  const mcp = (projectId: string): Mcp =>
    test.services.use(McpV1, { projectId });

  const live = (projectId: string) =>
    registrations.filter(
      (entry) => !entry.disposed && entry.options.projectId === projectId,
    );

  const fire = async (hook: RuntimeHook, input: unknown): Promise<void> => {
    const call = test.call(
      typeof input === 'object' && input !== null && 'threadId' in input
        ? (input as Record<string, string>)
        : undefined,
    );

    await Promise.all(
      handlers
        .filter((entry) => entry.hook === `runtime.hooks/v1#${hook}`)
        .map(async (entry) => {
          await entry.handler(input as never, call);
        }),
    );
  };

  return {
    env,
    test,
    mcp,
    unscoped: test.services.use(McpV1),
    registrations,
    live,
    liveNames: (projectId) =>
      live(projectId)
        .map((entry) => entry.tool.name)
        .sort(),
    tool: (projectId, name) => {
      const found = live(projectId).find((entry) => entry.tool.name === name);

      if (found === undefined) {
        throw new Error(
          `No live tool ${name} under ${projectId}; live: ${live(projectId)
            .map((entry) => entry.tool.name)
            .join(', ')}`,
        );
      }

      return found.tool;
    },
    promptCall: (projectId, signal) =>
      test.call(
        { projectId, threadId: 'thread-1', promptId: 'prompt-1' },
        signal,
      ),
    promptStarted: (projectId) =>
      fire('onPromptStartedHook', {
        projectId,
        threadId: 'thread-1',
        promptId: 'prompt-1',
        source: { kind: 'user' },
        cwd: '/workspace',
      }),
    projectClosing: (projectId) => fire('onProjectClosingHook', { projectId }),
    notice: (notice) => {
      for (const listener of [...listeners]) {
        listener(notice);
      }
    },
    attached,
    attachments,
    warnings,
    watchUntil: (projectId, predicate, label) =>
      new Promise((resolve, reject) => {
        let last: readonly McpServerView[] | undefined;
        let done = false;
        let subscription: Disposable | undefined;

        const finish = () => {
          done = true;
          clearTimeout(timer);
          queueMicrotask(() => subscription?.dispose());
        };
        const timer = setTimeout(() => {
          finish();
          reject(
            new Error(
              `Timed out watching ${projectId} for ${label}; last snapshot: ${JSON.stringify(last)}`,
            ),
          );
        }, WAIT_MS);

        const watching = mcp(projectId).watch(
          (servers: readonly McpServerView[]) => {
            last = servers;

            if (!done && predicate(servers)) {
              finish();
              resolve(servers);
            }
          },
        );
        subscription = watching;

        if (done) {
          watching.dispose();
        }
      }),
    listUntil: async (projectId, predicate, label) => {
      let last: readonly McpServerView[] = [];

      await eventually(
        async () => {
          last = await mcp(projectId).list();

          return predicate(last);
        },
        label,
        () => last,
      );

      return last;
    },
    deactivate: () => {
      deactivated ??= (async () => {
        if (typeof cleanup === 'function') {
          await (cleanup as () => unknown)();
        }

        await test.dispose();
        await backendWorld.dispose();
      })();

      return deactivated;
    },
  };
};

/** The view of the server with that id. */
export const serverOf = (
  servers: readonly McpServerView[],
  id: string,
): McpServerView | undefined => servers.find((server) => server.id === id);

/** Whether the server with that id is in that state. */
export const inState =
  (id: string, state: McpServerView['status']['state']) =>
  (servers: readonly McpServerView[]): boolean =>
    serverOf(servers, id)?.status.state === state;

/** An enabled http server configuration. */
export const httpServer = (
  name: string,
  url: string,
  headers: readonly McpEntry[] = [],
  enabled = true,
): McpServerInput => ({
  name,
  enabled,
  transport: { kind: 'http', url, headers },
});

/** An enabled stdio server configuration. */
export const stdioServer = (
  name: string,
  command: string,
  args: readonly string[] = [],
  env: readonly McpEntry[] = [],
  cwd?: string,
): McpServerInput => ({
  name,
  enabled: true,
  transport: {
    kind: 'stdio',
    command,
    args,
    env,
    ...(cwd === undefined ? {} : { cwd }),
  },
});
