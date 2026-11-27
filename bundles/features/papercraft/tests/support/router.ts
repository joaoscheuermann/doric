// The harness of `papercraft`'s host part through the router (phase 3, S57):
// `papercraft.programs/v1` and the `runtime.hooks/v1` handlers served by
// `createTestRouter` as `src/host/main.ts` serves them (`createPapercraftHost`,
// its `activate`), with recording fakes of section D's services:
// `files/v1` (`Content`, `ReadBytes` over a map of Project files),
// `runtime.lease/v1` (`Describe`, `Exec`, `PutFile`, `GetFile` over a
// `RunnerSandbox`, or a lease status), `runtime.threads/v1` (`ThreadEvents`
// over an in-memory log, `Instruct`), `hooks/v1` (`Register`), `events/v1`
// (`Register`, `Append`, which writes the row as `core` stores it: `{type,
// ...toJson(…, {alwaysEmitImplicit: true})}`) and `skills/v1` (`Register`).
// Each fake records its request, `callOf(context).scope`, its deadline and
// whether its signal was aborted.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  create,
  type DescService,
  fromJson,
  type JsonObject,
  type JsonValue,
  toJson,
} from '@bufbuild/protobuf';
import { anyPack, anyUnpack } from '@bufbuild/protobuf/wkt';
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
  deadlineOf,
  fromConnectError,
} from 'bundle/contracts';
import {
  RegisterRequestSchema as EventRegisterRequestSchema,
  EventsService,
} from 'bundle/contracts/gen/doric/events/v1/events_pb.js';
import {
  HookHandlerService,
  RegisterRequestSchema as HookRegisterRequestSchema,
  HooksService,
} from 'bundle/contracts/gen/doric/hooks/v1/hooks_pb.js';
import {
  RegisterRequestSchema as SkillRegisterRequestSchema,
  SkillsService,
} from 'bundle/contracts/gen/doric/skills/v1/skills_pb.js';
import type { HostContext, ServiceEntry } from 'bundle/host';
import { createTestRouter, type TestRouter } from 'bundle/testing';
import {
  ContentRequestSchema,
  FilesService,
  ReadBytesRequestSchema,
} from 'files/contracts/gen/doric/files/v1/files_pb.js';
import {
  OnPromptStartedHookInputSchema,
  OnThreadCwdChangedHookInputSchema,
} from 'runtime/contracts/gen/doric/runtime/hooks/v1/hooks_pb.js';
import {
  DescribeRequestSchema,
  ExecRequestSchema,
  GetFileRequestSchema,
  LeaseService,
} from 'runtime/contracts/gen/doric/runtime/lease/v1/lease_pb.js';
import {
  ThreadEventLogSchema,
  ThreadsService,
} from 'runtime/contracts/gen/doric/runtime/threads/v1/threads_pb.js';
import { ThreadEventSchema } from 'runtime/contracts/gen/doric/runtime/v2/runtime_pb.js';

import { PapercraftCwdSchema } from '../../src/contracts/gen/doric/papercraft/cwd/v1/cwd_pb.js';
import { ProgramsService } from '../../src/contracts/gen/doric/papercraft/programs/v1/programs_pb.js';
import type { NativePackages } from '../../src/host/native.js';
import type { RunnerSandbox } from '../../src/host/sandbox.js';
import {
  createPapercraftHost,
  type PapercraftHost,
} from '../../src/host/service.js';
import type {
  LibraryOutput,
  RunnerOutput,
} from '../../src/sandbox/protocol.js';

/** The bundle directory: `dist-tests/tests/support` is three levels below it. */
export const bundleRoot = fileURLToPath(new URL('../../..', import.meta.url));

export const projectId = 'project-1';
export const threadId = 'thread-1';
/** The scope a window's call of `papercraft.programs/v1` carries. */
export const windowScope: CallScope = { projectId, threadId };

/** `core`, as the router stamps it on its calls to the handler service. */
export const core: Caller = {
  bundleId: 'core',
  version: '1.0.0',
  generation: 1,
};

export const SKILL_PATH = 'src/host/skills/papercraft.md';
export const RUNNER_PATH = 'dist/sandbox/runner.mjs';
export const MIB = 1_048_576;

/** The services `papercraft`'s host part declares it calls (section D). */
export const REQUIRES: readonly string[] = [
  FilesService.typeName,
  LeaseService.typeName,
  'doric.comments.v1.CommentsService',
  HooksService.typeName,
  ThreadsService.typeName,
  SkillsService.typeName,
  EventsService.typeName,
];

/** One call a fake received. */
export interface FakeCall {
  /** `files.content`, `files.readBytes`, `lease.<method>`, `threads.<method>` or `events.append`. */
  readonly method: string;
  /** The request as JSON, implicit fields included, unset optional fields left out. */
  readonly request: JsonValue;
  readonly scope: CallScope | undefined;
  /** `deadlineOf(callOf(context))`, 0 when none. */
  readonly deadline: number;
  /** Whether the call's signal was aborted when the fake received it. */
  readonly aborted: boolean;
}

/** A stored row of the fake log, as `ThreadEvents` answers it (JSON). */
export interface StoredRow {
  readonly projectId: string;
  readonly threadId: string;
  readonly promptId: string;
  readonly sequence: number;
  readonly type: string;
  readonly event: JsonObject;
  readonly createdAt: string;
}

/** The fake lease: its state and the sandbox it runs on when `ready`. */
export interface LeaseState {
  status: 'ready' | 'pending' | 'unavailable' | 'expired' | 'missing';
  sandboxId: string;
  sandbox?: RunnerSandbox;
  /** Makes an `Exec` whose command `when` matches fail with `error`. */
  execFailure?: {
    readonly when: (cmd: readonly string[]) => boolean;
    readonly error: ContractError;
  };
}

/** Failures the fakes answer while set; a test sets and clears them. */
export interface Failures {
  registerSkill?: ContractError;
  registerEvent?: ContractError;
  append?: ContractError;
  threadEvents?: ContractError;
}

export interface WorldOptions {
  /**
   * `readAsset` given to `createPapercraftHost`; `'context'` gives none (the
   * real `context.assets`). Default: reads the bundle's own file.
   */
  readonly readAsset?: ((path: string) => Promise<Uint8Array>) | 'context';
  /** `createTestRouter`'s `bundleDir`; default the bundle's own directory. */
  readonly bundleDir?: string;
  /** `createPapercraftHost`'s `native`; default none (`context.assets.require`). */
  readonly native?: NativePackages;
  readonly now?: () => number;
}

export interface RouterWorld {
  readonly router: TestRouter;
  readonly host: PapercraftHost;
  readonly log: StoredRow[];
  /** Every call a fake received, in order. */
  readonly calls: FakeCall[];
  /** Registrations and calls in order: `events.register`, `hooks.register`, `skills.register`, then the call methods. */
  readonly timeline: string[];
  readonly eventRegisters: JsonValue[];
  readonly hookRegisters: JsonValue[];
  readonly skillRegisters: JsonValue[];
  /** Paths `readAsset` was asked for. */
  readonly assetReads: string[];
  /** Project files `files/v1` reads by Project path; `undefined`: the files lease is `pending`. */
  files: Record<string, string | Uint8Array> | undefined;
  readonly lease: LeaseState;
  /** Every `PutFile` the lease received: its path and the bytes of its chunks. */
  readonly puts: { readonly path: string; readonly chunks: Uint8Array[] }[];
  /** Answers replacing the fake `runtime.threads/v1`'s own, after the call was recorded. */
  readonly threadsAnswers: Partial<ServiceImpl<typeof ThreadsService>>;
  readonly failures: Failures;
  /** The recorded calls of one method. */
  callsOf(method: string): FakeCall[];
  programs(scope?: CallScope): Client<typeof ProgramsService>;
  hooks(scope?: CallScope): Client<typeof HookHandlerService>;
  /** `core` relays `onPromptStartedHook` for a prompt of `thread-1`, in the prompt's scope. */
  promptStarted(promptId: string, cwd: string): Promise<void>;
  /** `core` relays `onThreadCwdChangedHook` for `thread-1`. */
  cwdChanged(cwd: string, previous: string, promptId?: string): Promise<void>;
  /** Appends a row, as a prompt's own events would, and answers it. */
  row(promptId: string, type: string, event?: JsonObject): StoredRow;
  /**
   * The runtime's rewind of `promptId`: every row from its first row on goes,
   * and a `history.truncated` marker after the last kept row is appended.
   */
  rewind(promptId: string): void;
  /** `load_skill` with `{ name }`, started and finished, in `promptId`. */
  loadSkill(promptId: string, name?: string): void;
  /** The `papercraft.cwd/v1` rows' `cwd`s, in order. */
  cwds(): string[];
  /** Activates the part as `main.ts` does; rejects with what `activate` threw. */
  activate(): Promise<void>;
  /** Serves the part's services without running its `activate`. */
  serveWithoutActivate(): Promise<void>;
  /** Activates the router with no part (none is built) and answers the context it gave. */
  contextOf(): Promise<HostContext>;
  stop(): Promise<void>;
}

const fakeOf = <S extends DescService>(
  service: S,
  implementation: Partial<ServiceImpl<S>>,
): ServiceEntry => [service, implementation as ServiceImpl<S>] as ServiceEntry;

const timestamp = '2026-01-01T00:00:00.000Z';

/** Reads `path` from the bundle directory, as `context.assets.read` would after S62. */
export const readOwnAsset = async (path: string): Promise<Uint8Array> =>
  new Uint8Array(await readFile(join(bundleRoot, path)));

/** The `ContractError` a failed client call carries. */
export const contractErrorFrom = (error: unknown): ContractError =>
  fromConnectError(ConnectError.from(error));

/** The `ContractError` of `call`, which must fail. */
export const failureOf = async (
  call: () => Promise<unknown>,
): Promise<ContractError> => {
  try {
    await call();
  } catch (error) {
    return contractErrorFrom(error);
  }
  throw new Error('The call did not fail.');
};

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until `ready()` holds, failing with `what` after `ms`. */
export const until = async (
  ready: () => boolean,
  what: string,
  ms = 5000,
): Promise<void> => {
  const end = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}.`);
    await sleep(5);
  }
};

const bytesOf = (content: string | Uint8Array): Uint8Array =>
  typeof content === 'string' ? Buffer.from(content, 'utf8') : content;

/** `papercraft`'s host part on a test router, not yet activated. */
export const routerWorld = (options: WorldOptions = {}): RouterWorld => {
  const assetReads: string[] = [];
  const reader = options.readAsset ?? readOwnAsset;
  let built: PapercraftHost | undefined;
  /** The part, built at its first use (`contextOf` builds none). */
  const hostOf = (): PapercraftHost => {
    built ??= createPapercraftHost({
      ...(reader === 'context'
        ? {}
        : {
            readAsset: (path: string) => {
              assetReads.push(path);
              return reader(path);
            },
          }),
      ...(options.native === undefined ? {} : { native: options.native }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    return built;
  };
  const log: StoredRow[] = [];
  const calls: FakeCall[] = [];
  const timeline: string[] = [];
  const eventRegisters: JsonValue[] = [];
  const hookRegisters: JsonValue[] = [];
  const skillRegisters: JsonValue[] = [];
  const puts: { path: string; chunks: Uint8Array[] }[] = [];
  const threadsAnswers: Partial<ServiceImpl<typeof ThreadsService>> = {};
  const failures: Failures = {};
  const lease: LeaseState = { status: 'pending', sandboxId: 'sandbox-1' };
  const state: { files: Record<string, string | Uint8Array> | undefined } = {
    files: {},
  };
  let ids = 0;

  const record = (
    method: string,
    request: JsonValue,
    context: HandlerContext,
  ): void => {
    const call = callOf(context);
    calls.push({
      method,
      request,
      scope: call.scope,
      deadline: deadlineOf(call),
      aborted: context.signal.aborted,
    });
    timeline.push(method);
  };

  /** The last sequence the log gave; it never goes back, also after a rewind. */
  let sequence = 0;

  const row = (
    promptId: string,
    type: string,
    event: JsonObject = {},
  ): StoredRow => {
    sequence += 1;
    const stored: StoredRow = {
      projectId,
      threadId,
      promptId,
      sequence,
      type,
      event: { type, ...event },
      createdAt: timestamp,
    };
    log.push(stored);
    return stored;
  };

  /** A Project file by its path, leading `/`s dropped, as the kernel's fake reads it. */
  const fileAt = (
    path: string,
  ):
    | { readonly status: 'lease' }
    | { readonly status: 'not_found' | 'not_file' }
    | {
        readonly status: 'read';
        readonly path: string;
        readonly bytes: Uint8Array;
      } => {
    if (state.files === undefined) return { status: 'lease' };
    const relative = path.replace(/^\/+/u, '');
    const content = state.files[relative];

    if (content === undefined) {
      return Object.keys(state.files).some((name) =>
        name.startsWith(`${relative}/`),
      )
        ? { status: 'not_file' }
        : { status: 'not_found' };
    }

    return { status: 'read', path: relative, bytes: bytesOf(content) };
  };

  const filesFake = fakeOf(FilesService, {
    content: (request, context) => {
      record(
        'files.content',
        toJson(ContentRequestSchema, request, { alwaysEmitImplicit: true }),
        context,
      );
      const found = fileAt(request.path);

      if (found.status === 'lease') return { status: 'pending' };
      if (found.status !== 'read') {
        return { status: 'ready', value: { status: found.status } };
      }

      return {
        status: 'ready',
        value: {
          status: 'read',
          path: found.path,
          content: Buffer.from(found.bytes).toString('utf8'),
          truncated: false,
          binary: false,
        },
      };
    },
    readBytes: async function* (request, context) {
      record(
        'files.readBytes',
        toJson(ReadBytesRequestSchema, request, { alwaysEmitImplicit: true }),
        context,
      );
      const found = fileAt(request.path);

      if (found.status === 'lease') {
        yield { item: { case: 'head', value: { status: 'pending' } } };
        return;
      }
      if (found.status !== 'read') {
        yield {
          item: {
            case: 'head',
            value: { status: 'ready', value: { status: found.status } },
          },
        };
        return;
      }

      yield {
        item: {
          case: 'head',
          value: {
            status: 'ready',
            value: {
              status: 'read',
              path: found.path,
              truncated: false,
              binary: false,
            },
          },
        },
      };
      for (let start = 0; start < found.bytes.length; start += MIB) {
        yield {
          item: {
            case: 'chunk',
            value: found.bytes.subarray(start, start + MIB),
          },
        };
      }
    },
  });

  /** Fails as runtime's lease does for its state and `expectSandboxId`. */
  const check = (
    target: { readonly expectSandboxId?: string } | undefined,
  ): RunnerSandbox => {
    if (lease.status !== 'ready' || lease.sandbox === undefined) {
      throw new ContractError('unavailable', 'The lease is not ready.', {
        leaseStatus: lease.status === 'ready' ? 'pending' : lease.status,
      });
    }
    if (
      target?.expectSandboxId !== undefined &&
      target.expectSandboxId !== lease.sandboxId
    ) {
      throw new ContractError('unavailable', 'The sandbox changed.', {
        leaseStatus: 'unavailable',
      });
    }

    return lease.sandbox;
  };

  const leaseFake = fakeOf(LeaseService, {
    describe: (request, context) => {
      record(
        'lease.describe',
        toJson(DescribeRequestSchema, request, { alwaysEmitImplicit: true }),
        context,
      );
      const sandbox = check(request.target);

      return { id: lease.sandboxId, root: sandbox.root };
    },
    exec: async (request, context) => {
      record(
        'lease.exec',
        toJson(ExecRequestSchema, request, { alwaysEmitImplicit: true }),
        context,
      );
      const sandbox = check(request.target);
      const input = request.request;
      const cmd = [...(input?.cmd ?? [])];

      if (lease.execFailure?.when(cmd) === true) throw lease.execFailure.error;

      const result = await sandbox.exec({
        cmd,
        ...(input?.cwd === undefined ? {} : { cwd: input.cwd }),
        ...(input?.timeoutMs === undefined
          ? {}
          : { timeoutMs: input.timeoutMs }),
      });

      return {
        response: {
          ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
          stdout: result.stdout,
          stderr: result.stderr,
          stdoutBytes: result.stdoutBytes,
          stderrBytes: result.stderrBytes,
        },
      };
    },
    putFile: async (requests, context) => {
      let path: string | undefined;
      let expectSandboxId: string | undefined;
      const chunks: Uint8Array[] = [];

      for await (const item of requests) {
        if (item.item.case === 'head') {
          path = item.item.value.request?.path;
          expectSandboxId = item.item.value.target?.expectSandboxId;
        } else if (item.item.case === 'chunk') {
          chunks.push(item.item.value);
        }
      }
      record(
        'lease.putFile',
        {
          path: path ?? '',
          ...(expectSandboxId === undefined ? {} : { expectSandboxId }),
          chunks: chunks.map((chunk) => chunk.length),
        },
        context,
      );
      const sandbox = check(
        expectSandboxId === undefined ? undefined : { expectSandboxId },
      );
      puts.push({ path: path ?? '', chunks });
      await sandbox.putFile(path ?? '', Buffer.concat(chunks));

      return {};
    },
    getFile: async function* (request, context) {
      record(
        'lease.getFile',
        toJson(GetFileRequestSchema, request, { alwaysEmitImplicit: true }),
        context,
      );
      const sandbox = check(request.target);
      const bytes = await sandbox.getFile(request.request?.path ?? '');

      for (let start = 0; start < bytes.length; start += MIB) {
        yield { chunk: bytes.subarray(start, start + MIB) };
      }
    },
  });

  /** Records the call, then answers with the test's answer or the fake's own. */
  const recorded = <M extends keyof ServiceImpl<typeof ThreadsService>>(
    method: M,
    own: ServiceImpl<typeof ThreadsService>[M],
  ) =>
    ((request: { readonly $typeName: string }, context: HandlerContext) => {
      const input = ThreadsService.method[method].input;
      record(
        `threads.${method}`,
        toJson(input, request as never, { alwaysEmitImplicit: true }),
        context,
      );
      const answer = (threadsAnswers[method] ?? own) as (
        request: unknown,
        context: HandlerContext,
      ) => unknown;
      return answer(request, context);
    }) as unknown as ServiceImpl<typeof ThreadsService>[M];

  const threadsFake = fakeOf(ThreadsService, {
    threadEvents: recorded('threadEvents', (request) => {
      if (failures.threadEvents !== undefined) throw failures.threadEvents;
      const rows = log.filter((entry) => entry.threadId === request.id);
      if (rows.length === 0) return {};
      return {
        threadEventLog: create(ThreadEventLogSchema, {
          events: rows
            .filter((entry) => entry.sequence > request.afterSequence)
            .map((entry) =>
              fromJson(ThreadEventSchema, entry as unknown as JsonValue),
            ),
          lastSequence: sequence,
        }),
      };
    }),
    instruct: recorded('instruct', (request) => ({
      steerResult: {
        status: 'steered',
        promptId: request.promptId ?? 'running',
      },
    })),
  });

  const router = createTestRouter({
    requires: REQUIRES,
    instance: { bundleId: 'papercraft' },
    bundleDir: options.bundleDir ?? bundleRoot,
    fakes: [
      filesFake,
      leaseFake,
      threadsFake,
      fakeOf(HooksService, {
        register: (request) => {
          timeline.push('hooks.register');
          hookRegisters.push(toJson(HookRegisterRequestSchema, request));
          ids += 1;
          return { registrationId: `hook-${ids}` };
        },
        unregister: () => ({}),
      }),
      fakeOf(EventsService, {
        register: (request) => {
          timeline.push('events.register');
          eventRegisters.push(toJson(EventRegisterRequestSchema, request));
          if (failures.registerEvent !== undefined) {
            throw failures.registerEvent;
          }
          ids += 1;
          return { registrationId: `event-${ids}` };
        },
        unregister: () => ({}),
        append: (request, context) => {
          const unpacked =
            request.payload === undefined
              ? undefined
              : anyUnpack(request.payload, PapercraftCwdSchema);
          const payload =
            unpacked === undefined
              ? {}
              : (toJson(PapercraftCwdSchema, unpacked, {
                  alwaysEmitImplicit: true,
                }) as JsonObject);
          record('events.append', { type: request.type, payload }, context);
          if (failures.append !== undefined) throw failures.append;
          const scope = callOf(context).scope ?? {};
          if (
            scope.threadId !== threadId ||
            scope.promptId === undefined ||
            unpacked === undefined
          ) {
            throw new Error('Append needs a prompt scope and a cwd payload.');
          }
          row(scope.promptId, request.type, payload);
          return {};
        },
      }),
      fakeOf(SkillsService, {
        register: (request) => {
          timeline.push('skills.register');
          skillRegisters.push(toJson(SkillRegisterRequestSchema, request));
          if (failures.registerSkill !== undefined) {
            throw failures.registerSkill;
          }
          ids += 1;
          return { registrationId: `skill-${ids}` };
        },
        unregister: () => ({}),
      }),
    ],
  });

  const services = () =>
    [
      [ProgramsService, hostOf().programs],
      [HookHandlerService, hostOf().hooks.implementation],
    ] as const;

  const hooks = (scope?: CallScope) =>
    router.client(HookHandlerService, {
      caller: core,
      ...(scope === undefined ? {} : { scope }),
    });

  return {
    router,
    get host() {
      return hostOf();
    },
    log,
    calls,
    timeline,
    eventRegisters,
    hookRegisters,
    skillRegisters,
    assetReads,
    get files() {
      return state.files;
    },
    set files(files) {
      state.files = files;
    },
    lease,
    puts,
    threadsAnswers,
    failures,
    callsOf: (method) => calls.filter((entry) => entry.method === method),
    programs: (scope = windowScope) =>
      router.client(ProgramsService, { scope }),
    hooks,
    promptStarted: async (promptId, cwd) => {
      await hooks({ projectId, threadId, promptId }).handle({
        contract: 'runtime.hooks/v1',
        hook: 'onPromptStartedHook',
        input: anyPack(
          OnPromptStartedHookInputSchema,
          create(OnPromptStartedHookInputSchema, {
            projectId,
            threadId,
            promptId,
            source: { kind: { case: 'user', value: {} } },
            cwd,
          }),
        ),
      });
    },
    cwdChanged: async (cwd, previous, promptId) => {
      await hooks({
        projectId,
        threadId,
        ...(promptId === undefined ? {} : { promptId }),
      }).handle({
        contract: 'runtime.hooks/v1',
        hook: 'onThreadCwdChangedHook',
        input: anyPack(
          OnThreadCwdChangedHookInputSchema,
          create(OnThreadCwdChangedHookInputSchema, {
            projectId,
            threadId,
            ...(promptId === undefined ? {} : { promptId }),
            cwd,
            previous: { cwd: previous },
          }),
        ),
      });
    },
    row,
    rewind: (promptId) => {
      const first = log.findIndex((entry) => entry.promptId === promptId);
      if (first < 0) return;
      log.splice(first);
      row(promptId, 'history.truncated', {
        afterSequence: log.at(-1)?.sequence ?? 0,
      });
    },
    loadSkill: (promptId, name = 'papercraft') => {
      const call = {
        id: `call-${String(sequence + 1)}`,
        name: 'load_skill',
        payload: { name },
      };
      row(promptId, 'tool.started', { call });
      row(promptId, 'tool.finished', { call, record: { output: { name } } });
    },
    cwds: () =>
      log
        .filter((entry) => entry.type === 'papercraft.cwd/v1')
        .map((entry) => String(entry.event.cwd)),
    activate: async () => {
      const host = hostOf();
      await router.activate({
        services: services(),
        activate: (context: HostContext) => host.activate(context),
        deactivate: () => host.deactivate(),
      });
    },
    contextOf: async () => {
      let captured: HostContext | undefined;
      await router.activate({
        services: [],
        activate: (context: HostContext) => {
          captured = context;
        },
      });
      if (captured === undefined) throw new Error('No context was given.');
      return captured;
    },
    serveWithoutActivate: async () => {
      await router.activate({
        services: services(),
        activate: () => undefined,
      });
    },
    stop: () => router.control.stop(),
  };
};

/* A scripted sandbox ------------------------------------------------------- */

/** The input the host wrote for one runner job, as JSON. */
export type JobInput = Readonly<Record<string, unknown>>;

export interface ScriptedSandbox extends RunnerSandbox {
  /** The sandbox's files by absolute path. */
  readonly files: Map<string, Uint8Array>;
  /** Every command `exec` ran, in order. */
  readonly commands: (readonly string[])[];
  /** Every runner job's input, in order. */
  readonly jobs: JobInput[];
}

const execResult = (exitCode: number) => ({
  exitCode,
  stdout: '',
  stderr: '',
  stdoutBytes: new Uint8Array(),
  stderrBytes: new Uint8Array(),
});

/**
 * A sandbox over an in-memory file table whose `node <runner> <input> <output>`
 * writes `answer(input)` as the output (the sandbox is the boundary); `test`,
 * `rm` and every other command act on the table or succeed.
 */
export const scriptedSandbox = (
  answer: (input: JobInput) => unknown,
  root = '/workspace',
): ScriptedSandbox => {
  const files = new Map<string, Uint8Array>();
  const commands: (readonly string[])[] = [];
  const jobs: JobInput[] = [];

  return {
    id: 'sandbox-1',
    root,
    files,
    commands,
    jobs,
    exec: async ({ cmd }) => {
      commands.push(cmd);
      const [program, ...args] = cmd;
      const path = args.at(-1) ?? '';

      if (program === 'test' && args[0] === '-f') {
        return execResult(files.has(path) ? 0 : 1);
      }
      if (program === 'test' && args[0] === '-d') {
        return execResult(
          [...files.keys()].some((name) => name.startsWith(`${path}/`)) ? 0 : 1,
        );
      }
      if (program === 'rm') {
        for (const name of [...files.keys()]) {
          if (name === path || name.startsWith(`${path}/`)) files.delete(name);
        }
        return execResult(0);
      }
      if (program === 'node') {
        const [, inputPath = '', outputPath = ''] = args;
        const input = JSON.parse(
          Buffer.from(files.get(inputPath) ?? new Uint8Array()).toString(
            'utf8',
          ),
        ) as JobInput;
        jobs.push(input);
        files.set(
          outputPath,
          Buffer.from(JSON.stringify(await answer(input)), 'utf8'),
        );
        return execResult(0);
      }

      return execResult(0);
    },
    putFile: async (path, bytes) => {
      files.set(path, new Uint8Array(bytes));
    },
    getFile: async (path) => {
      const bytes = files.get(path);
      if (bytes === undefined) throw new Error(`ENOENT: ${path}`);
      return bytes;
    },
  };
};

/* Runner answers ----------------------------------------------------------- */

export const sha256 = (bytes: string | Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

/** A runner's `built` library answer with one component, `AppButton`. */
export const builtLibrary = (
  root: string,
  marker: string,
  extra: Partial<Extract<LibraryOutput, { status: 'built' }>> = {},
): LibraryOutput => ({
  status: 'built',
  root,
  js: `export const components = []; export const marker = ${JSON.stringify(marker)};`,
  components: [
    {
      name: 'AppButton',
      description: 'The app button.',
      signature: 'AppButton(label: string)',
      file: '.doric/papercraft/schemas/AppButton.tsx',
    },
  ],
  sources: {},
  globalCss: [],
  componentCss: [],
  styles: {},
  windowSpecifiers: [],
  hostSpecifiers: [],
  warnings: [],
  manifest: { '.doric/papercraft/schemas/AppButton.tsx': sha256(marker) },
  ...extra,
});

/** A runner's `built` bundle answer (an `Export`). */
export const builtExport = (
  marker: string,
  extra: Partial<Extract<RunnerOutput, { status: 'built' }>> = {},
): RunnerOutput => ({
  status: 'built',
  js: `export const marker = ${JSON.stringify(marker)}; export function mount() {}`,
  exportName: 'default',
  sources: {},
  globalCss: [],
  componentCss: [],
  styles: {},
  windowSpecifiers: [],
  hostSpecifiers: [],
  warnings: [],
  ...extra,
});

/** Whether a runner job's input is a library job. */
export const isLibraryJob = (input: JobInput): boolean =>
  input.kind === 'library';

/* Export sources ----------------------------------------------------------- */

/** The component `Export` builds: `src/Badge.tsx`, whose sheet names `font`. */
export const BADGE_PATH = 'src/Badge.tsx';

/** A Project whose `src/Badge.tsx` imports a sheet naming `src/face.woff2` (bytes `font`). */
export const badgeProject = (
  font: Uint8Array,
): Record<string, string | Uint8Array> => ({
  [BADGE_PATH]: [
    "import './badge.css';",
    'export default function Badge() {',
    '  return <span className="badge p-2">badge</span>;',
    '}',
  ].join('\n'),
  'src/badge.css': [
    "@font-face { font-family: 'Face'; src: url('./face.woff2') format('woff2'); }",
    ".badge { font-family: 'Face'; }",
  ].join('\n'),
  'src/face.woff2': font,
});

/** A small font's bytes. */
export const FONT = Uint8Array.from([0x77, 0x4f, 0x46, 0x32, 0x00, 0x01]);
