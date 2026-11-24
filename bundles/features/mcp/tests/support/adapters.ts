// The harness of `mcp`'s routed adapters (phase 3, S59b): `createTestRouter`
// with recording fakes of the services the adapters call — `secrets/v1`
// (over an in-memory map), `tools/v1` (`Register`, `Unregister`, `List`),
// `runtime.lease/v1` (`Describe`, and `Start` driven by the test),
// `runtime.attachments/v1` (`Attach`), `runtime/v2` (`Watch`, driven by the
// test) and `storage/v1` (`Get`). The bundle serves `ToolHandlerService`
// from one `createToolHandlers()` table, in which the harness also registers
// a `probe` tool: `within(scope, run)` executes it, so `run` runs inside a
// handler's call (its scope, deadline and signal), as a bundle's handler
// does. Each fake records its request, `callOf(context).scope`, its deadline
// and its signal.

import {
  type DescService,
  fromJson,
  type JsonValue,
  type MessageInitShape,
  toJson,
} from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';
import {
  ConnectError,
  type HandlerContext,
  type ServiceImpl,
} from '@connectrpc/connect';
import {
  type Call,
  type CallScope,
  ContractError,
  callOf,
  deadlineOf,
  fromConnectError,
} from 'bundle/contracts';
import {
  type CredentialDescriptionSchema,
  SecretsService,
} from 'bundle/contracts/gen/doric/secrets/v1/secrets_pb.js';
import { StorageService } from 'bundle/contracts/gen/doric/storage/v1/storage_pb.js';
import {
  type RegisteredToolSchema,
  RegisterRequestSchema,
  ToolHandlerService,
  ToolsService,
} from 'bundle/contracts/gen/doric/tools/v1/tools_pb.js';
import {
  createToolHandlers,
  type HostContext,
  type ServiceEntry,
  type ToolHandlers,
} from 'bundle/host';
import { createTestRouter, type TestRouter } from 'bundle/testing';
import { AttachmentsService } from 'runtime/contracts/gen/doric/runtime/attachments/v1/attachments_pb.js';
import {
  DescribeRequestSchema,
  LeaseService,
  StartHeadSchema,
  type StartResponseSchema,
} from 'runtime/contracts/gen/doric/runtime/lease/v1/lease_pb.js';
import {
  RuntimeService,
  type WatchResponseSchema,
} from 'runtime/contracts/gen/doric/runtime/v2/runtime_pb.js';
import { defineTool } from 'tool';
import { z } from 'zod';

export const P1 = 'project-1';
export const P2 = 'project-2';
export const THREAD = 'thread-1';
export const MIB = 1_048_576;
export const SANDBOX_ID = 'sandbox-1';
export const PROBE = 'probe';

/** The services the adapters call (section 5's `requires`). */
export const REQUIRES: readonly string[] = [
  StorageService.typeName,
  SecretsService.typeName,
  ToolsService.typeName,
  'doric.hooks.v1.HooksService',
  'doric.log.v1.LogService',
  RuntimeService.typeName,
  LeaseService.typeName,
  AttachmentsService.typeName,
];

/** One call a fake received. */
export interface FakeCall {
  /** `<service>.<method>`, as `secrets.describe` or `lease.start`. */
  readonly method: string;
  readonly request: JsonValue;
  readonly scope: CallScope | undefined;
  /** `deadlineOf(callOf(context))`, 0 when none. */
  readonly deadline: number;
  /** The call's signal: aborted when its caller cancels it. */
  readonly signal: AbortSignal;
}

/** A stored credential of the fake `secrets/v1`. */
export interface StoredCredential {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly username?: string;
  readonly email?: string;
  readonly secret?: string;
}

/** One `Start` stream, driven by the test. */
export interface FakeProcess {
  readonly head: JsonValue;
  readonly scope: CallScope | undefined;
  readonly deadline: number;
  readonly signal: AbortSignal;
  readonly writes: string[];
  readonly resizes: { readonly cols: number; readonly rows: number }[];
  output(stream: 'stdout' | 'stderr', data: string): void;
  /** Sends the `exit` item and ends the call; `exitCode` absent stays absent. */
  exit(result?: {
    readonly exitCode?: number;
    readonly stdout?: string;
    readonly stderr?: string;
  }): void;
  /** Ends the call with no `exit`. */
  end(): void;
  /** Fails the call with `error` after `started`. */
  fail(error: ContractError): void;
}

/** One opening of `runtime/v2.Watch`, driven by the test. */
export interface FakeWatch {
  readonly scope: CallScope | undefined;
  readonly deadline: number;
  readonly signal: AbortSignal;
  push(item: MessageInitShape<typeof WatchResponseSchema>): void;
  fail(error: ContractError): void;
  /** Ends the stream cleanly: no error, as a drained runtime generation does. */
  end(): void;
}

/** One `Attach` the fake received. */
export interface FakeAttach {
  readonly name: string | undefined;
  readonly chunks: Uint8Array[];
  readonly scope: CallScope | undefined;
}

export interface AdapterWorld {
  readonly router: TestRouter;
  readonly handlers: ToolHandlers;
  readonly calls: FakeCall[];
  callsOf(method: string): FakeCall[];
  /** The fake `secrets/v1`'s credentials, by id, in insertion order. */
  readonly credentials: Map<string, StoredCredential>;
  /** Each `tools/v1.Register` but the probe's, as JSON. */
  readonly registers: JsonValue[];
  /** The `registrationId`s `tools/v1.Unregister` received. */
  readonly unregisters: string[];
  /** What `tools/v1.List` answers. */
  listed: MessageInitShape<typeof RegisteredToolSchema>[];
  /** What `Describe` answers: the sandbox, or an error to throw. */
  describe: { readonly id: string; readonly root: string } | ContractError;
  /** An error `Start` fails with before `started`, when set. */
  startError: ContractError | undefined;
  readonly processes: FakeProcess[];
  readonly watches: FakeWatch[];
  readonly attaches: FakeAttach[];
  /** An error `Attach` fails with, when set. */
  attachError: ContractError | undefined;
  /** Errors a method of the fakes fails with, by `<service>.<method>`. */
  readonly failures: Map<string, ContractError>;
  /** Activates the router (once) and answers the bundle's context. */
  context(): Promise<HostContext>;
  /**
   * Runs `run` inside a `ToolHandlerService.Execute` call made with `scope` and, when given, `timeoutMs`; answers
   * what `run` answered once the call returned.
   */
  within<T>(
    run: (call: Call) => Promise<T>,
    options?: { readonly scope?: CallScope; readonly timeoutMs?: number },
  ): Promise<T>;
  /** `core`'s `ToolHandlerService.Execute{name, projectId, payload}` as JSON. */
  execute(
    name: string,
    projectId: string,
    payload: JsonValue,
    options?: { readonly scope?: CallScope; readonly signal?: AbortSignal },
  ): Promise<JsonValue | undefined>;
  stop(): Promise<void>;
}

/** The `ContractError` a routed call failed with. */
export const contractErrorFrom = (error: unknown): ContractError =>
  error instanceof ContractError
    ? error
    : fromConnectError(ConnectError.from(error));

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

type StartItem = MessageInitShape<typeof StartResponseSchema>;

const descriptionOf = (
  credential: StoredCredential,
): MessageInitShape<typeof CredentialDescriptionSchema> => ({
  id: credential.id,
  kind: credential.kind,
  name: credential.name,
  ...(credential.username === undefined
    ? {}
    : { username: credential.username }),
  ...(credential.email === undefined ? {} : { email: credential.email }),
  hasSecret: credential.secret !== undefined && credential.secret !== '',
});

export const adapterWorld = (): AdapterWorld => {
  const calls: FakeCall[] = [];
  const credentials = new Map<string, StoredCredential>();
  const registers: JsonValue[] = [];
  const unregisters: string[] = [];
  const processes: FakeProcess[] = [];
  const watches: FakeWatch[] = [];
  const attaches: FakeAttach[] = [];
  const failures = new Map<string, ContractError>();
  const handlers = createToolHandlers();
  let ids = 0;
  let probe: (call: Call) => Promise<unknown> = async () => undefined;

  const state: {
    listed: MessageInitShape<typeof RegisteredToolSchema>[];
    describe: { readonly id: string; readonly root: string } | ContractError;
    startError: ContractError | undefined;
    attachError: ContractError | undefined;
  } = {
    listed: [],
    describe: { id: SANDBOX_ID, root: '/workspace' },
    startError: undefined,
    attachError: undefined,
  };

  const record = (
    method: string,
    request: JsonValue,
    context: HandlerContext,
  ): Call => {
    const call = callOf(context);
    calls.push({
      method,
      request,
      scope: call.scope,
      deadline: deadlineOf(call),
      signal: context.signal,
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

  const secretsFake = fakeOf(SecretsService, {
    resolve: (request, context) => {
      const id = request.credentialRef?.id ?? '';
      record('secrets.resolve', { id }, context);
      const credential = credentialOf(id);

      return { secret: { ...credential } };
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
      const json: Record<string, JsonValue> = {
        kind: request.kind,
        name: request.name,
      };
      if (request.username !== undefined) json.username = request.username;
      if (request.email !== undefined) json.email = request.email;
      if (request.secret !== undefined) json.secret = request.secret;
      record('secrets.create', json, context);
      ids += 1;
      const credential: StoredCredential = {
        id: `credential-${ids}`,
        kind: request.kind,
        name: request.name,
        ...(request.username === undefined
          ? {}
          : { username: request.username }),
        ...(request.email === undefined ? {} : { email: request.email }),
        ...(request.secret === undefined ? {} : { secret: request.secret }),
      };
      credentials.set(credential.id, credential);

      return { credentialDescription: descriptionOf(credential) };
    },
    update: (request, context) => {
      const id = request.ref?.id ?? '';
      const update: Record<string, JsonValue> = {};
      for (const key of [
        'kind',
        'name',
        'username',
        'email',
        'secret',
      ] as const) {
        const value = request.update?.[key];
        if (value !== undefined) update[key] = value;
      }
      record('secrets.update', { id, update }, context);
      const credential = { ...credentialOf(id) } as Record<string, string>;
      for (const [key, value] of Object.entries(update)) {
        if (value === '' && key !== 'name' && key !== 'kind')
          delete credential[key];
        else credential[key] = String(value);
      }
      const updated = credential as unknown as StoredCredential;
      credentials.set(id, updated);

      return { credentialDescription: descriptionOf(updated) };
    },
    delete: (request, context) => {
      const id = request.credentialRef?.id ?? '';
      record('secrets.delete', { id }, context);
      if (id === 'referenced') return { result: 'referenced' };

      return { result: credentials.delete(id) ? 'deleted' : 'missing' };
    },
    list: (_request, context) => {
      record('secrets.list', {}, context);

      return {
        credentials: [...credentials.values()].map(descriptionOf),
      };
    },
  });

  const toolsFake = fakeOf(ToolsService, {
    register: (request, context) => {
      const json = toJson(RegisterRequestSchema, request);
      if (request.tool?.name !== PROBE) {
        registers.push(json);
        record('tools.register', json, context);
      }
      ids += 1;

      return { registrationId: `tool-${ids}` };
    },
    unregister: (request, context) => {
      unregisters.push(request.registrationId);
      record(
        'tools.unregister',
        { registrationId: request.registrationId },
        context,
      );

      return {};
    },
    list: (_request, context) => {
      record('tools.list', {}, context);

      return { tools: state.listed };
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
      const head =
        !first.done && first.value.item.case === 'head'
          ? toJson(StartHeadSchema, first.value.item.value)
          : null;
      const call = record('lease.start', head, context);

      if (state.startError !== undefined) throw state.startError;

      const items = channel<StartItem | ContractError>();
      const process: FakeProcess = {
        head,
        scope: call.scope,
        deadline: deadlineOf(call),
        signal: context.signal,
        writes: [],
        resizes: [],
        output: (stream, data) =>
          items.push({ item: { case: 'output', value: { stream, data } } }),
        exit: (result = {}) => {
          const stdout = result.stdout ?? '';
          const stderr = result.stderr ?? '';
          items.push({
            item: {
              case: 'exit',
              value: {
                ...(result.exitCode === undefined
                  ? {}
                  : { exitCode: result.exitCode }),
                stdout,
                stderr,
                stdoutBytes: new TextEncoder().encode(stdout),
                stderrBytes: new TextEncoder().encode(stderr),
              },
            },
          });
          items.close();
        },
        end: () => items.close(),
        fail: (error) => {
          items.push(error);
          items.close();
        },
      };

      void (async () => {
        for (;;) {
          const next = await iterator.next().catch(() => undefined);
          if (next === undefined || next.done) return;
          const { item } = next.value;
          if (item.case === 'write') process.writes.push(item.value);
          if (item.case === 'resize') {
            process.resizes.push({
              cols: item.value.cols,
              rows: item.value.rows,
            });
          }
        }
      })();
      context.signal.addEventListener('abort', () => items.close(), {
        once: true,
      });
      processes.push(process);
      yield { item: { case: 'started', value: {} } };

      for await (const item of items.drain()) {
        if (item instanceof ContractError) throw item;
        yield item;
      }
    },
  });

  const attachmentsFake = fakeOf(AttachmentsService, {
    attach: async (requests, context) => {
      const call = callOf(context);
      const attach: FakeAttach = {
        name: undefined,
        chunks: [],
        scope: call.scope,
      };
      let name: string | undefined;
      for await (const { item } of requests) {
        if (item.case === 'head') name = item.value.name;
        if (item.case === 'chunk') attach.chunks.push(item.value);
      }
      const recorded = { ...attach, name };
      attaches.push(recorded);
      record('attachments.attach', { name: name ?? null }, context);
      if (state.attachError !== undefined) throw state.attachError;
      const size = recorded.chunks.reduce(
        (total, chunk) => total + chunk.length,
        0,
      );

      return {
        attachment: {
          id: `sha256-${'a'.repeat(64)}`,
          name: name ?? '',
          mediaType: 'image/png',
          size,
        },
      };
    },
  });

  const runtimeFake = fakeOf(RuntimeService, {
    watch: async function* (_request, context) {
      const call = record('runtime.watch', {}, context);
      const items = channel<
        MessageInitShape<typeof WatchResponseSchema> | ContractError
      >();
      watches.push({
        scope: call.scope,
        deadline: deadlineOf(call),
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

  const storageFake = fakeOf(StorageService, {
    get: async function* (request, context) {
      record('storage.get', { type: request.type, id: request.id }, context);
      // No stored document: the stream ends with no item.
      yield* [];
    },
  });

  const router = createTestRouter({
    requires: REQUIRES,
    instance: { bundleId: 'mcp' },
    fakes: [
      secretsFake,
      toolsFake,
      leaseFake,
      attachmentsFake,
      runtimeFake,
      storageFake,
    ],
  });

  const probeTool = defineTool<z.ZodObject, z.ZodString, undefined>({
    name: PROBE,
    input: z.looseObject({}),
    output: z.string(),
    execute: async (_input, call) => {
      await probe(call);

      return '';
    },
  }).bind(undefined);

  let activated: Promise<HostContext> | undefined;
  const context = (): Promise<HostContext> => {
    activated ??= (async () => {
      let captured: HostContext | undefined;
      await router.activate({
        services: [[ToolHandlerService, handlers.implementation]],
        activate: async (given: HostContext) => {
          captured = given;
          await handlers.register(given, probeTool, { alwaysAvailable: false });
        },
      });
      if (captured === undefined) throw new Error('No context was given.');

      return captured;
    })();

    return activated;
  };

  return {
    router,
    handlers,
    calls,
    callsOf: (method) => calls.filter((call) => call.method === method),
    credentials,
    registers,
    unregisters,
    get listed() {
      return state.listed;
    },
    set listed(listed) {
      state.listed = listed;
    },
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
    processes,
    watches,
    attaches,
    get attachError() {
      return state.attachError;
    },
    set attachError(error) {
      state.attachError = error;
    },
    failures,
    context,
    within: async <T>(
      run: (call: Call) => Promise<T>,
      options: { readonly scope?: CallScope; readonly timeoutMs?: number } = {},
    ): Promise<T> => {
      await context();
      let answer: { readonly value: T } | undefined;
      probe = async (call) => {
        answer = { value: await run(call) };
      };
      try {
        await router
          .client(
            ToolHandlerService,
            options.scope === undefined ? {} : { scope: options.scope },
          )
          .execute(
            { name: PROBE, payload: fromJson(ValueSchema, {}) },
            options.timeoutMs === undefined
              ? {}
              : { timeoutMs: options.timeoutMs },
          );
      } catch (error) {
        throw contractErrorFrom(error);
      }
      if (answer === undefined) throw new Error('The probe did not run.');

      return answer.value;
    },
    execute: async (name, projectId, payload, options = {}) => {
      await context();
      try {
        const { result } = await router
          .client(ToolHandlerService, {
            scope: options.scope ?? { projectId, threadId: THREAD },
          })
          .execute(
            { name, projectId, payload: fromJson(ValueSchema, payload) },
            options.signal === undefined ? {} : { signal: options.signal },
          );

        return result === undefined ? undefined : toJson(ValueSchema, result);
      } catch (error) {
        throw contractErrorFrom(error);
      }
    },
    stop: () => router.control.stop(),
  };
};
