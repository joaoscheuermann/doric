// The routed world of `mcp`'s host part as a process (phase 3, S59c):
// `mcp/v1`, `default.skill-sources/v1`, the MCP tools' `ToolHandlerService`
// and the `runtime.hooks/v1` handlers' `HookHandlerService`, served by
// `createTestRouter` as `src/host/main.ts` serves them (`createMcpHost`, its
// `activate`), beside recording fakes of section D's services:
// - `storage/v1`: `serveStorage` over the in-memory backend, as `core`
//   serves it (`DefineType` recorded and refusable);
// - `secrets/v1`: an in-memory credential map with today's kinds and errors;
// - `tools/v1`: `Register`/`Unregister`/`List` over a live registry, and
//   `execute`, which calls the bundle's `ToolHandlerService` as `core` does;
// - `hooks/v1`: `Register` recorded;
// - `runtime/v2`: `Watch`, an item queue the test pushes;
// - `runtime.lease/v1`: `Describe` and `Start` over `sandbox.ts`'s fake
//   sandbox (each started process runs an in-process MCP server), or a
//   refusal;
// - `runtime.attachments/v1`: `Attach` recorded (head, bytes, scope).
// Every fake records its request, `callOf(context).scope`, the deadline and
// whether the call's signal was already aborted when it arrived.

import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TestContext } from 'node:test';

import {
  create,
  type DescService,
  fromJson,
  type JsonValue,
  type MessageInitShape,
  toJson,
} from '@bufbuild/protobuf';
import { anyPack, ValueSchema } from '@bufbuild/protobuf/wkt';
import {
  type Client,
  ConnectError,
  type HandlerContext,
  type ServiceImpl,
} from '@connectrpc/connect';
import {
  type Caller,
  type CallScope,
  ContractError,
  callOf,
  type Disposable,
  deadlineOf,
  fromConnectError,
  type Storage,
  type StorageBackend,
  StorageBackendV1,
  type StorageTypeDefinition,
} from 'bundle/contracts';
import {
  HookHandlerService,
  RegisterRequestSchema as HookRegisterRequestSchema,
  HooksService,
} from 'bundle/contracts/gen/doric/hooks/v1/hooks_pb.js';
import {
  type CredentialDescriptionSchema,
  SecretsService,
} from 'bundle/contracts/gen/doric/secrets/v1/secrets_pb.js';
import { StorageService } from 'bundle/contracts/gen/doric/storage/v1/storage_pb.js';
import {
  type ContractTool as ContractToolMessage,
  ToolHandlerService,
  ToolsService,
} from 'bundle/contracts/gen/doric/tools/v1/tools_pb.js';
import {
  ajvValidators,
  type HostContext,
  type ServiceEntry,
} from 'bundle/host';
import {
  createTestRouter,
  createTestServices,
  type TestLogRecord,
  type TestRouter,
} from 'bundle/testing';
import { SkillSourcesService } from 'default/contracts/gen/doric/default/skill_sources/v1/skill_sources_pb.js';
import { AttachmentsService } from 'runtime/contracts/gen/doric/runtime/attachments/v1/attachments_pb.js';
import {
  OnProjectClosingHookInputSchema,
  OnProjectReadyHookInputSchema,
  OnPromptStartedHookInputSchema,
} from 'runtime/contracts/gen/doric/runtime/hooks/v1/hooks_pb.js';
import {
  DescribeRequestSchema,
  LeaseService,
  type StartResponseSchema,
} from 'runtime/contracts/gen/doric/runtime/lease/v1/lease_pb.js';
import {
  RuntimeService,
  type WatchResponseSchema,
} from 'runtime/contracts/gen/doric/runtime/v2/runtime_pb.js';
import { createMemoryStore, memoryStorageBackend } from 'storage/memory';
import { serveStorage } from 'storage/rpc';

import {
  type McpServerInputSchema,
  McpServerViewSchema,
  McpService,
} from '../../src/contracts/gen/doric/mcp/v1/mcp_pb.js';
import type { McpEntry, McpServerInput } from '../../src/contracts/index.js';
import { createMcpHost, type McpHost } from '../../src/host/service.js';
import {
  type FakeAuthorizationServer,
  followRedirect,
} from './oauth-server.js';
import {
  type FakeSandbox,
  type FakeSandboxOptions,
  fakeSandbox,
  type StartedProcess,
} from './sandbox.js';
import { WAIT_MS } from './wait.js';

/** Two Projects, by the UUIDs the runtime gives Projects (as `world.ts`). */
export const P1 = '11111111-1111-4111-8111-111111111111';
export const P2 = '22222222-2222-4222-8222-222222222222';
export const THREAD = 'thread-1';
export const PROMPT = 'prompt-1';
export const SANDBOX_ID = 'sandbox-1';
export const SERVER_TYPE = 'mcp.server/v1';

/** `core`, as the router stamps it on its calls to the handler services. */
export const core: Caller = {
  bundleId: 'core',
  version: '1.0.0',
  generation: 1,
};

/** The services `mcp`'s host part declares it calls (section 5's `requires`, Q5). */
export const REQUIRES: readonly string[] = [
  StorageService.typeName,
  SecretsService.typeName,
  ToolsService.typeName,
  HooksService.typeName,
  'doric.log.v1.LogService',
  RuntimeService.typeName,
  LeaseService.typeName,
  AttachmentsService.typeName,
];

/** One call a fake received. */
export interface FakeCall {
  /** `<service>.<method>`, as `secrets.describe`, `storage.query` or `lease.start`. */
  readonly method: string;
  readonly request: JsonValue;
  readonly scope: CallScope | undefined;
  /** `deadlineOf(callOf(context))`, 0 when none. */
  readonly deadline: number;
  /** Whether the call's signal was already aborted when the fake received it. */
  readonly aborted: boolean;
}

/** A credential of the fake `secrets/v1`. */
export interface StoredCredential {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly secret?: string;
}

/** One `tools/v1.Register` the fake registry received. */
export interface ToolRegistration {
  readonly registrationId: string;
  readonly name: string;
  readonly description: string | undefined;
  /** The definition's input schema, parsed. */
  readonly inputSchema: unknown;
  readonly strict: boolean | undefined;
  readonly projectId: string | undefined;
  readonly order: number | undefined;
  readonly alwaysAvailable: boolean;
  readonly scope: CallScope | undefined;
  readonly deadline: number;
  /** Whether `Unregister` named it. */
  unregistered: boolean;
  readonly tool: ContractToolMessage;
}

/** One `Start` stream: its head as sent and the fake process it started. */
export interface FakeStart {
  /** `{target: {expectSandboxId?}, request: {cmd, cwd?, env, tty?}}`. */
  readonly head: {
    readonly target: { readonly expectSandboxId?: string };
    readonly request: {
      readonly cmd: readonly string[];
      readonly cwd?: string;
      readonly env: readonly string[];
      readonly tty?: boolean;
    };
  };
  readonly scope: CallScope | undefined;
  readonly deadline: number;
  /** The `Start` call's signal: aborted when the bundle cancels the stream. */
  readonly signal: AbortSignal;
  /** The fake sandbox's process, once started. */
  readonly process: StartedProcess;
}

/** One opening of `runtime/v2.Watch`, driven by the test. */
export interface FakeWatch {
  readonly scope: CallScope | undefined;
  readonly signal: AbortSignal;
  push(item: MessageInitShape<typeof WatchResponseSchema>): void;
  fail(error: ContractError): void;
  end(): void;
}

/** One `Attach` the fake received. */
export interface FakeAttach {
  readonly name: string | undefined;
  readonly bytes: Uint8Array;
  readonly scope: CallScope | undefined;
}

/** A server view as the wire answers it, implicit fields included. */
export interface View {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly signedIn: boolean;
  readonly status: { readonly state: string; readonly message?: string };
  readonly tools: readonly {
    readonly name: string;
    readonly title?: string;
    readonly description?: string;
  }[];
  readonly skills: readonly {
    readonly uri: string;
    readonly name: string;
    readonly description: string;
  }[];
  readonly transport: JsonValue;
}

export interface RouterWorldOptions {
  readonly sandbox?: FakeSandboxOptions;
}

export interface RouterWorld {
  readonly router: TestRouter;
  /** The part under test (`createMcpHost()`), built on first use. */
  readonly host: McpHost;
  readonly calls: readonly FakeCall[];
  callsOf(method: string): readonly FakeCall[];
  /**
   * Activation steps and calls in order: `storage.defineType`, `secrets.registerKind`, `hooks.register`,
   * `runtime.watch`, `tools.*`, `lease.*`, `attachments.*`.
   */
  readonly timeline: readonly string[];
  /** Each `DefineType` as `{type, indexes}`. */
  readonly defineTypes: readonly JsonValue[];
  /** Each `RegisterKind`'s definition as JSON (implicit fields emitted). */
  readonly kindRegisters: readonly JsonValue[];
  /** Each `hooks/v1.Register` as `{contract, hook}`. */
  readonly hookRegisters: readonly { contract: string; hook: string }[];
  readonly credentials: Map<string, StoredCredential>;
  readonly registrations: readonly ToolRegistration[];
  /** The registered, not unregistered, tool names of the Project, sorted. */
  liveNames(projectId: string): readonly string[];
  /** What `Describe` answers: the sandbox, or an error to throw. */
  describe: { readonly id: string; readonly root: string } | ContractError;
  /** An error `Start` fails with before `started`, when set. */
  startError: ContractError | undefined;
  readonly sandbox: FakeSandbox;
  readonly starts: readonly FakeStart[];
  readonly watches: readonly FakeWatch[];
  readonly attaches: readonly FakeAttach[];
  /** An error `Attach` fails with, when set. */
  attachError: ContractError | undefined;
  /** Errors a fake method fails with, by `<service>.<method>`. */
  readonly failures: Map<string, ContractError>;
  /** Every stored `mcp.server/v1` document, as storage keeps it. */
  documents(): readonly Record<string, unknown>[];
  /** What the part wrote through `context.log`. */
  readonly logs: readonly TestLogRecord[];
  /** Adds an API_TOKEN credential and answers its id. */
  addCredential(name: string, secret?: string, kind?: string): string;
  /** `mcp/v1` as a window of the Project calls it; `undefined` → no scope. */
  mcp(projectId: string | undefined): Client<typeof McpService>;
  /** `default.skill-sources/v1` as `default` calls it for a prompt of the Project; `undefined` → no scope. */
  skillSources(
    projectId: string | undefined,
  ): Client<typeof SkillSourcesService>;
  /** `HookHandlerService` as `core` calls it. */
  hooks(scope?: CallScope): Client<typeof HookHandlerService>;
  promptStarted(
    projectId: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<void>;
  projectClosing(projectId: string): Promise<void>;
  projectReady(projectId: string): Promise<void>;
  /** `core`'s `ToolHandlerService.Execute{name, projectId, payload}` in a prompt's scope; the result as JSON. */
  execute(
    name: string,
    projectId: string,
    payload: JsonValue,
    options?: { readonly signal?: AbortSignal },
  ): Promise<JsonValue | undefined>;
  /** `Create` of the domain input; answers the view. */
  create(projectId: string, input: McpServerInput): Promise<View>;
  /** `Update` of the domain input; answers the view. */
  update(projectId: string, id: string, input: McpServerInput): Promise<View>;
  list(projectId: string): Promise<readonly View[]>;
  /** Opens `Watch` until an item satisfies `predicate`; answers that item. */
  watchUntil(
    projectId: string,
    predicate: (servers: readonly View[]) => boolean,
    label: string,
  ): Promise<readonly View[]>;
  /** Activates the part as `main.ts` does; rejects with what `activate` threw. */
  activate(): Promise<void>;
  /** Serves the part's services without running its `activate`. */
  serveWithoutActivate(): Promise<void>;
  /** The part's own `deactivate`, the router still serving. */
  deactivate(): Promise<void>;
  stop(): Promise<void>;
}

/** A routed world activated for the test; stopped when the test ends. */
export const activated = async (
  t: TestContext,
  options?: RouterWorldOptions,
): Promise<RouterWorld> => {
  const world = routerWorld(options);
  t.after(() => world.stop());
  await world.activate();

  return world;
};

/** The whole interactive sign-in over `mcp/v1`: `SignIn`, the user's consent, the browser redirect, `FinishSignIn`. */
export const signInThrough = async (
  world: RouterWorld,
  projectId: string,
  id: string,
  as: FakeAuthorizationServer,
): Promise<View> => {
  const mcp = world.mcp(projectId);
  const { url } = await mcp.signIn({ id });
  const approval = as.approve(url);
  const finishing = mcp.finishSignIn({ id });
  await followRedirect(approval);
  const { mcpServerView } = await finishing;
  if (mcpServerView === undefined) throw new Error('No view answered.');

  return viewOf(mcpServerView);
};

/** An HTTP proxy to `target` that holds every request until `open()`; closed when the test ends. */
export interface GatedProxy {
  /** The proxied endpoint, as `target`'s path on the proxy's port. */
  readonly url: string;
  /** How many requests arrived, held or not. */
  readonly received: () => number;
  open(): void;
}

export const gatedProxy = async (
  t: TestContext,
  target: string,
): Promise<GatedProxy> => {
  const destination = new URL(target);
  let opened = false;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let received = 0;
  const server = createServer((req, res) => {
    received += 1;
    void gate.then(() => {
      const forward = httpRequest(
        {
          host: destination.hostname,
          port: destination.port,
          method: req.method,
          path: req.url,
          headers: { ...req.headers, host: destination.host },
        },
        (answer) => {
          res.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(res);
        },
      );
      forward.on('error', () => res.destroy());
      req.pipe(forward);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${String(port)}${destination.pathname}`,
    received: () => received,
    open: () => {
      if (opened) return;
      opened = true;
      release();
    },
  };
};

/** The `ContractError` a routed call failed with. */
export const contractErrorFrom = (error: unknown): ContractError =>
  error instanceof ContractError
    ? error
    : fromConnectError(ConnectError.from(error));

/** The `ContractError` `call` rejected with; fails when it resolved. */
export const failureOf = async (
  call: () => Promise<unknown>,
): Promise<ContractError> => {
  try {
    await call();
  } catch (error) {
    return contractErrorFrom(error);
  }
  throw new Error('The call resolved; a failure was expected.');
};

/** The gRPC status `call` rejected with (`Code` of `@connectrpc/connect`). */
export const statusOf = async (
  call: () => Promise<unknown>,
): Promise<number> => {
  try {
    await call();
  } catch (error) {
    return ConnectError.from(error).code;
  }
  throw new Error('The call resolved; a failure was expected.');
};

/** A view message as `View`. */
export const viewOf = (
  message: Parameters<typeof toJson<typeof McpServerViewSchema>>[1],
): View =>
  toJson(McpServerViewSchema, message, {
    alwaysEmitImplicit: true,
  }) as unknown as View;

/** The view of the server with that id. */
export const serverOf = (
  servers: readonly View[],
  id: string,
): View | undefined => servers.find((server) => server.id === id);

/** Whether the server with that id is in that state. */
export const inState =
  (id: string, state: string) =>
  (servers: readonly View[]): boolean =>
    serverOf(servers, id)?.status.state === state;

const entryMessage = (entry: McpEntry) =>
  'credentialId' in entry
    ? {
        name: entry.name,
        source: { case: 'credentialId' as const, value: entry.credentialId },
      }
    : {
        name: entry.name,
        source: { case: 'value' as const, value: entry.value },
      };

/** A domain server input as the wire's `McpServerInput`. */
export const inputMessage = (
  input: McpServerInput,
): MessageInitShape<typeof McpServerInputSchema> => {
  const { transport } = input;

  return {
    name: input.name,
    enabled: input.enabled,
    transport:
      transport.kind === 'http'
        ? {
            kind: {
              case: 'http',
              value: {
                url: transport.url,
                headers: transport.headers.map(entryMessage),
                clientName: transport.clientName,
                scopes: [...(transport.scopes ?? [])],
                clientInfo: transport.clientInfo,
              },
            },
          }
        : {
            kind: {
              case: 'stdio',
              value: {
                command: transport.command,
                args: [...transport.args],
                cwd: transport.cwd,
                env: transport.env.map(entryMessage),
                clientInfo: transport.clientInfo,
              },
            },
          },
  };
};

const fakeOf = <S extends DescService>(
  service: S,
  implementation: Partial<ServiceImpl<S>>,
): ServiceEntry => [service, implementation as ServiceImpl<S>] as ServiceEntry;

/** An unbounded async queue a fake drains; `close` ends it. */
const channel = <T>() => {
  const items: T[] = [];
  let wake: (() => void) | undefined;
  let closed = false;

  return {
    push: (item: T) => {
      items.push(item);
      wake?.();
    },
    close: () => {
      closed = true;
      wake?.();
    },
    async *drain(): AsyncGenerator<T> {
      for (;;) {
        const item = items.shift();

        if (item !== undefined) {
          yield item;
          continue;
        }

        if (closed) return;

        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    },
  };
};

/** `Storage` over a backend, as `core`'s facade: a type declared before first use, every put checked. */
const storageOver = (backend: StorageBackend): Storage => {
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

  return {
    defineType(definition): Disposable {
      types.set(definition.type, definition);
      return { dispose: () => undefined };
    },
    async get(key) {
      await ready(key.type);
      return backend.get(key);
    },
    async query(query) {
      await ready(query.type);
      return backend.query(query);
    },
    read: (request) => backend.read(request),
    async commit(batch) {
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
    putBlob: (bytes) => backend.putBlob(bytes),
    getBlob: (hash) => backend.getBlob(hash),
    deleteBlob: (hash) => backend.deleteBlob(hash),
  };
};

type StartItem = MessageInitShape<typeof StartResponseSchema>;

const descriptionOf = (
  credential: StoredCredential,
): MessageInitShape<typeof CredentialDescriptionSchema> => ({
  id: credential.id,
  kind: credential.kind,
  name: credential.name,
  hasSecret: credential.secret !== undefined && credential.secret !== '',
});

/** `mcp`'s host part on a test router, not yet activated. */
export const routerWorld = (options: RouterWorldOptions = {}): RouterWorld => {
  const calls: FakeCall[] = [];
  const timeline: string[] = [];
  const defineTypes: JsonValue[] = [];
  const kindRegisters: JsonValue[] = [];
  const hookRegisters: { contract: string; hook: string }[] = [];
  const credentials = new Map<string, StoredCredential>();
  const registrations: ToolRegistration[] = [];
  const starts: FakeStart[] = [];
  const watches: FakeWatch[] = [];
  const attaches: FakeAttach[] = [];
  const failures = new Map<string, ContractError>();
  const sandbox = fakeSandbox(options.sandbox);
  const store = createMemoryStore();
  const backendServices = createTestServices({
    bundle: { id: 'mcp-storage' },
    provide: [memoryStorageBackend(store)],
  });
  const storage = serveStorage(
    storageOver(backendServices.services.use(StorageBackendV1)),
    { validators: ajvValidators() },
  );
  let ids = 0;
  let host: McpHost | undefined;
  const hostOf = (): McpHost => {
    host ??= createMcpHost();
    return host;
  };

  const state: {
    describe: { readonly id: string; readonly root: string } | ContractError;
    startError: ContractError | undefined;
    attachError: ContractError | undefined;
  } = {
    describe: { id: SANDBOX_ID, root: '/workspace' },
    startError: undefined,
    attachError: undefined,
  };

  const record = (
    method: string,
    request: JsonValue,
    context: HandlerContext,
  ) => {
    const call = callOf(context);
    timeline.push(method);
    calls.push({
      method,
      request,
      scope: call.scope,
      deadline: deadlineOf(call),
      aborted: context.signal.aborted,
    });
    const failure = failures.get(method);
    if (failure !== undefined) throw failure;

    return call;
  };

  const credentialOf = (id: string): StoredCredential => {
    const credential = credentials.get(id);
    if (credential === undefined) {
      throw new ContractError('credential_missing', `No credential ${id}.`, {
        credentialId: id,
      });
    }

    return credential;
  };

  const storageFake = fakeOf(StorageService, {
    ...storage,
    defineType: async (request, context) => {
      defineTypes.push({
        type: request.type,
        indexes: request.indexes.map((index) => ({
          name: index.name,
          fields: [...index.fields],
        })),
      });
      record('storage.defineType', { type: request.type }, context);

      return await storage.defineType(request, context);
    },
    query: async function* (request, context) {
      record(
        'storage.query',
        { type: request.storageQuery?.type ?? '' },
        context,
      );

      yield* storage.query(request, context);
    },
  });

  const secretsFake = fakeOf(SecretsService, {
    registerKind: (request, context) => {
      const definition = request.credentialKindDefinition;
      const json: JsonValue = {
        id: definition?.id ?? '',
        required: [...(definition?.required ?? [])],
        optional: [...(definition?.optional ?? [])],
        label: definition?.label ?? '',
      };
      kindRegisters.push(json);
      record('secrets.registerKind', json, context);
      ids += 1;

      return { registrationId: `kind-${ids}` };
    },
    resolve: (request, context) => {
      const id = request.credentialRef?.id ?? '';
      record('secrets.resolve', { id }, context);

      return { secret: { ...credentialOf(id) } };
    },
    describe: (request, context) => {
      const id = request.credentialRef?.id ?? '';
      record('secrets.describe', { id }, context);
      const credential = credentials.get(id);

      return credential === undefined
        ? {}
        : { credentialDescription: descriptionOf(credential) };
    },
    create: (request, context) => {
      record(
        'secrets.create',
        { kind: request.kind, name: request.name },
        context,
      );
      if (
        [...credentials.values()].some(
          (entry) => entry.kind === request.kind && entry.name === request.name,
        )
      ) {
        throw new ContractError(
          'credential_name_taken',
          `A ${request.kind} credential named ${request.name} is stored.`,
        );
      }
      ids += 1;
      const credential: StoredCredential = {
        id: `credential-${ids}`,
        kind: request.kind,
        name: request.name,
        ...(request.secret === undefined ? {} : { secret: request.secret }),
      };
      credentials.set(credential.id, credential);

      return { credentialDescription: descriptionOf(credential) };
    },
    update: (request, context) => {
      const id = request.ref?.id ?? '';
      record('secrets.update', { id }, context);
      const found = credentialOf(id);
      const secret = request.update?.secret;
      const updated: StoredCredential = {
        ...found,
        ...(secret === undefined || secret === '' ? {} : { secret }),
      };
      credentials.set(id, updated);

      return { credentialDescription: descriptionOf(updated) };
    },
    delete: (request, context) => {
      const id = request.credentialRef?.id ?? '';
      record('secrets.delete', { id }, context);

      return { result: credentials.delete(id) ? 'deleted' : 'missing' };
    },
    list: (_request, context) => {
      record('secrets.list', {}, context);

      return { credentials: [...credentials.values()].map(descriptionOf) };
    },
  });

  const live = (projectId: string | undefined) =>
    registrations.filter(
      (entry) =>
        !entry.unregistered &&
        (entry.projectId === undefined || entry.projectId === projectId),
    );

  const toolsFake = fakeOf(ToolsService, {
    register: (request, context) => {
      const tool = request.tool;
      const call = record(
        'tools.register',
        {
          name: tool?.name ?? '',
          projectId: request.options?.projectId ?? null,
        },
        context,
      );
      ids += 1;
      const registrationId = `tool-${ids}`;
      const schema = tool?.definition?.inputSchema;
      registrations.push({
        registrationId,
        name: tool?.name ?? '',
        description: tool?.description,
        inputSchema:
          schema === undefined || schema === ''
            ? undefined
            : (JSON.parse(schema) as unknown),
        strict: tool?.definition?.strict,
        projectId: request.options?.projectId,
        order: request.options?.order,
        alwaysAvailable: request.options?.alwaysAvailable ?? false,
        scope: call.scope,
        deadline: deadlineOf(call),
        unregistered: false,
        tool: tool as ContractToolMessage,
      });

      return { registrationId };
    },
    unregister: (request, context) => {
      record(
        'tools.unregister',
        { registrationId: request.registrationId },
        context,
      );
      for (const entry of registrations) {
        if (entry.registrationId === request.registrationId) {
          entry.unregistered = true;
        }
      }

      return {};
    },
    list: (_request, context) => {
      const call = record('tools.list', {}, context);

      return {
        tools: live(call.scope?.projectId).map((entry) => ({
          bundleId: 'mcp',
          alwaysAvailable: entry.alwaysAvailable,
          ...(entry.order === undefined ? {} : { order: entry.order }),
          ...(entry.projectId === undefined
            ? {}
            : { projectId: entry.projectId }),
          tool: entry.tool,
        })),
      };
    },
  });

  const hooksFake = fakeOf(HooksService, {
    register: (request, context) => {
      const json = toJson(HookRegisterRequestSchema, request) as {
        contract: string;
        hook: string;
      };
      hookRegisters.push({ contract: json.contract, hook: json.hook });
      record(
        'hooks.register',
        { contract: json.contract, hook: json.hook },
        context,
      );
      ids += 1;

      return { registrationId: `hook-${ids}` };
    },
    unregister: () => ({}),
  });

  const runtimeFake = fakeOf(RuntimeService, {
    watch: async function* (_request, context) {
      const call = record('runtime.watch', {}, context);
      const items = channel<
        MessageInitShape<typeof WatchResponseSchema> | ContractError
      >();
      watches.push({
        scope: call.scope,
        signal: context.signal,
        push: (item) => items.push(item),
        fail: (error) => {
          items.push(error);
          items.close();
        },
        end: () => items.close(),
      });
      context.signal.addEventListener('abort', () => items.close(), {
        once: true,
      });

      for await (const item of items.drain()) {
        if (item instanceof ContractError) throw item;
        yield item;
      }
    },
  });

  const leaseFake = fakeOf(LeaseService, {
    describe: (request, context) => {
      record('lease.describe', toJson(DescribeRequestSchema, request), context);
      if (state.describe instanceof ContractError) throw state.describe;

      return state.describe;
    },
    start: async function* (requests, context) {
      const iterator = requests[Symbol.asyncIterator]();
      const first = await iterator.next();
      const value =
        !first.done && first.value.item.case === 'head'
          ? first.value.item.value
          : undefined;
      const request = value?.request;
      const head: FakeStart['head'] = {
        target: {
          ...(value?.target?.expectSandboxId === undefined
            ? {}
            : { expectSandboxId: value.target.expectSandboxId }),
        },
        request: {
          cmd: [...(request?.cmd ?? [])],
          ...(request?.cwd === undefined ? {} : { cwd: request.cwd }),
          env: [...(request?.env ?? [])],
          ...(request?.tty === undefined ? {} : { tty: request.tty }),
        },
      };
      const call = record('lease.start', head as unknown as JsonValue, context);

      if (state.startError !== undefined) throw state.startError;

      const start = sandbox.sandbox.start;
      if (start === undefined) {
        throw new ContractError(
          'unsupported_operation',
          'The sandbox cannot keep a process running.',
        );
      }

      const items = channel<StartItem>();
      const process = await start({
        cmd: head.request.cmd,
        ...(head.request.cwd === undefined ? {} : { cwd: head.request.cwd }),
        env: head.request.env,
        ...(head.request.tty === undefined ? {} : { tty: head.request.tty }),
        onOutput: (output) =>
          items.push({
            item: {
              case: 'output',
              value: { stream: output.stream, data: output.data },
            },
          }),
      });
      const started = sandbox.started.at(-1);
      if (started === undefined) throw new Error('No process started.');
      starts.push({
        head,
        scope: call.scope,
        deadline: deadlineOf(call),
        signal: context.signal,
        process: started,
      });

      void process.result.then((result) => {
        items.push({
          item: {
            case: 'exit',
            value: {
              ...(result.exitCode === null
                ? {}
                : { exitCode: result.exitCode }),
              stdout: result.stdout,
              stderr: result.stderr,
              stdoutBytes: result.stdoutBytes,
              stderrBytes: result.stderrBytes,
            },
          },
        });
        items.close();
      });
      void (async () => {
        for (;;) {
          const next = await iterator.next().catch(() => undefined);
          if (next === undefined || next.done) return;
          if (next.value.item.case === 'write') {
            await process.write(next.value.item.value).catch(() => undefined);
          }
        }
      })();
      context.signal.addEventListener(
        'abort',
        () => {
          void process.terminate();
          items.close();
        },
        { once: true },
      );

      yield { item: { case: 'started', value: {} } };
      yield* items.drain();
    },
  });

  const attachmentsFake = fakeOf(AttachmentsService, {
    attach: async (requests, context) => {
      const call = callOf(context);
      let name: string | undefined;
      const chunks: Uint8Array[] = [];
      for await (const { item } of requests) {
        if (item.case === 'head') name = item.value.name;
        if (item.case === 'chunk') chunks.push(item.value);
      }
      const bytes = Buffer.concat(chunks);
      attaches.push({ name, bytes, scope: call.scope });
      record('attachments.attach', { name: name ?? null }, context);
      if (state.attachError !== undefined) throw state.attachError;

      return {
        attachment: {
          id: `sha256-${'a'.repeat(64)}`,
          name: name ?? '',
          mediaType: 'image/png',
          size: bytes.length,
        },
      };
    },
  });

  const router = createTestRouter({
    requires: REQUIRES,
    instance: { bundleId: 'mcp' },
    fakes: [
      storageFake,
      secretsFake,
      toolsFake,
      hooksFake,
      runtimeFake,
      leaseFake,
      attachmentsFake,
    ],
  });

  const services = () => {
    const part = hostOf();

    return [
      [McpService, part.mcp],
      [SkillSourcesService, part.skillSources],
      [ToolHandlerService, part.tools.implementation],
      [HookHandlerService, part.hooks.implementation],
    ] as const;
  };

  const mcp = (projectId: string | undefined) =>
    router.client(
      McpService,
      projectId === undefined ? {} : { scope: { projectId } },
    );

  const hooks = (scope?: CallScope) =>
    router.client(HookHandlerService, {
      caller: core,
      ...(scope === undefined ? {} : { scope }),
    });

  const routed = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      throw contractErrorFrom(error);
    }
  };

  const list = async (projectId: string): Promise<readonly View[]> =>
    routed(async () =>
      (await mcp(projectId).list({})).servers.map((server) => viewOf(server)),
    );

  return {
    router,
    get host() {
      return hostOf();
    },
    calls,
    callsOf: (method) => calls.filter((entry) => entry.method === method),
    timeline,
    defineTypes,
    kindRegisters,
    hookRegisters,
    credentials,
    registrations,
    liveNames: (projectId) =>
      registrations
        .filter((entry) => !entry.unregistered && entry.projectId === projectId)
        .map((entry) => entry.name)
        .sort(),
    get describe() {
      return state.describe;
    },
    set describe(describe) {
      state.describe = describe;
    },
    get startError() {
      return state.startError;
    },
    set startError(error) {
      state.startError = error;
    },
    sandbox,
    starts,
    watches,
    attaches,
    get attachError() {
      return state.attachError;
    },
    set attachError(error) {
      state.attachError = error;
    },
    failures,
    documents: () =>
      [...(store.documents.get(SERVER_TYPE)?.values() ?? [])].map(
        (document) => document.value as Record<string, unknown>,
      ),
    get logs() {
      return router.logs;
    },
    addCredential: (name, secret, kind = 'API_TOKEN') => {
      ids += 1;
      const id = `credential-${ids}`;
      credentials.set(id, {
        id,
        kind,
        name,
        ...(secret === undefined ? {} : { secret }),
      });

      return id;
    },
    mcp,
    skillSources: (projectId) =>
      router.client(
        SkillSourcesService,
        projectId === undefined
          ? {}
          : { scope: { projectId, threadId: THREAD, promptId: PROMPT } },
      ),
    hooks,
    promptStarted: async (projectId, { signal } = {}) => {
      await routed(() =>
        hooks({ projectId, threadId: THREAD, promptId: PROMPT }).handle(
          {
            contract: 'runtime.hooks/v1',
            hook: 'onPromptStartedHook',
            input: anyPack(
              OnPromptStartedHookInputSchema,
              create(OnPromptStartedHookInputSchema, {
                projectId,
                threadId: THREAD,
                promptId: PROMPT,
                source: { kind: { case: 'user', value: {} } },
                cwd: '/workspace',
              }),
            ),
          },
          signal === undefined ? {} : { signal },
        ),
      );
    },
    projectClosing: async (projectId) => {
      await routed(() =>
        hooks({ projectId }).handle({
          contract: 'runtime.hooks/v1',
          hook: 'onProjectClosingHook',
          input: anyPack(
            OnProjectClosingHookInputSchema,
            create(OnProjectClosingHookInputSchema, { projectId }),
          ),
        }),
      );
    },
    projectReady: async (projectId) => {
      await routed(() =>
        hooks({ projectId }).handle({
          contract: 'runtime.hooks/v1',
          hook: 'onProjectReadyHook',
          input: anyPack(
            OnProjectReadyHookInputSchema,
            create(OnProjectReadyHookInputSchema, { projectId }),
          ),
        }),
      );
    },
    execute: (name, projectId, payload, { signal } = {}) =>
      routed(async () => {
        const { result } = await router
          .client(ToolHandlerService, {
            caller: core,
            scope: { projectId, threadId: THREAD, promptId: PROMPT },
          })
          .execute(
            { name, projectId, payload: fromJson(ValueSchema, payload) },
            signal === undefined ? {} : { signal },
          );

        return result === undefined ? undefined : toJson(ValueSchema, result);
      }),
    create: (projectId, input) =>
      routed(async () => {
        const { mcpServerView } = await mcp(projectId).create({
          mcpServerInput: inputMessage(input),
        });
        if (mcpServerView === undefined) throw new Error('No view answered.');

        return viewOf(mcpServerView);
      }),
    update: (projectId, id, input) =>
      routed(async () => {
        const { mcpServerView } = await mcp(projectId).update({
          id,
          mcpServerInput: inputMessage(input),
        });
        if (mcpServerView === undefined) throw new Error('No view answered.');

        return viewOf(mcpServerView);
      }),
    list,
    watchUntil: (projectId, predicate, label) =>
      routed(async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), WAIT_MS);
        let last: readonly View[] | undefined;
        try {
          for await (const item of mcp(projectId).watch(
            {},
            { signal: controller.signal },
          )) {
            last = item.servers.map((server) => viewOf(server));
            if (predicate(last)) return last;
          }
        } catch (error) {
          if (!controller.signal.aborted) throw error;
        } finally {
          clearTimeout(timer);
          controller.abort();
        }
        throw new Error(
          `Timed out watching ${projectId} for ${label}; last item: ${JSON.stringify(last)}`,
        );
      }),
    activate: async () => {
      const part = hostOf();
      await router.activate({
        services: services(),
        activate: (context: HostContext) => part.activate(context),
        deactivate: () => part.deactivate(),
      });
    },
    serveWithoutActivate: async () => {
      await router.activate({
        services: services(),
        activate: () => undefined,
      });
    },
    deactivate: () => hostOf().deactivate(),
    stop: async () => {
      await router.control.stop();
      await backendServices.dispose();
    },
  };
};
