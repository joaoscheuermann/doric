// A fake `sandbox/v1` provider by lease id (phase 3, slice S47a, contract
// §5): what the harness serves to the routed sandbox port and to
// `runtime.lease/v1`. Built from today's `SandboxProviderOptions`, it keeps
// each acquisition's `Sandbox` under a new lease id and runs every lease
// operation on it, converting the messages itself (independently of the
// bundle's `rpc/sandbox.ts`, so a converter bug cannot cancel out).

import { create, type JsonValue, toJson } from '@bufbuild/protobuf';
import type { HandlerContext, ServiceImpl } from '@connectrpc/connect';
import { ContractError } from 'bundle/contracts';
import type { ServiceEntry } from 'bundle/host';
import type {
  CloneRepoInput,
  Sandbox,
  SandboxDiffInput,
  SandboxExecInput,
  SandboxExecResult,
  SandboxProcess,
  SandboxProcessInput,
  SandboxProcessOutput,
  SandboxSshAccess,
  SandboxStats,
} from 'sandbox';
import { chunkBytes, joinChunks } from 'storage/rpc';

import {
  CloneRepoRequestSchema,
  DiffRequestSchema,
  ExecRequestSchema,
  ReadFileRequestSchema,
  type SandboxExecInput as ExecInputMessage,
  SandboxExecResultSchema,
  SandboxService,
  SandboxSshAccessSchema,
  SandboxStatsSchema,
  WriteFileRequestSchema,
} from '../../src/contracts/gen/doric/sandbox/v1/sandbox_pb.js';
import {
  sandbox as defaultSandbox,
  type SandboxProviderOptions,
  type SandboxRecord,
} from '../support/sandbox.js';

/** One lease operation the fake received, with the signal of its call. */
export interface FakeLeaseOperation {
  /** The `sandbox/v1` method, lower camel case (`exec`, `getFile`, …). */
  readonly method: string;
  readonly leaseId: string;
  /** The signal of the call (aborted on cancel, deadline or stop). */
  readonly signal: AbortSignal;
}

/** One `PutFile` call as it arrived. */
export interface FakePutFile {
  readonly leaseId: string;
  readonly path: string;
  /** The items after the head: each chunk's length, in order. */
  readonly chunks: number[];
  /** The bytes given to `putFile`, once the request side closed. */
  written?: Uint8Array;
}

/** One `Start` call: its head and every later request item, in order. */
export interface FakeStart {
  readonly leaseId: string;
  readonly cmd: readonly string[];
  readonly signal: AbortSignal;
  readonly requests: (
    | { readonly write: string }
    | { readonly resize: readonly [number, number] }
  )[];
}

export interface FakeSandboxProviderOptions extends SandboxProviderOptions {
  /** Shared with the harness: what the domain acquired, discarded and released. */
  readonly record?: SandboxRecord;
  /** Records each call as `sandbox.<method>` and its request as JSON. */
  readonly log?: (method: string, request: JsonValue) => void;
  /** Awaited before each lease operation resolves its lease. */
  readonly beforeOperation?: (
    operation: Omit<FakeLeaseOperation, 'signal'>,
  ) => void | Promise<void>;
}

export interface FakeSandboxProvider {
  /** The `[SandboxService, impl]` entry for `createTestRouter`'s `fakes`. */
  readonly entry: ServiceEntry;
  readonly record: SandboxRecord;
  /** Every lease operation, in arrival order. */
  readonly operations: FakeLeaseOperation[];
  readonly putFiles: FakePutFile[];
  readonly starts: FakeStart[];
  /** The leases the fake holds now, by id. */
  leases(): readonly string[];
  /** Forgets `leaseId` without releasing it: later operations fail `unknown_lease`. */
  drop(leaseId: string): void;
}

/** A queue a server stream reads while a process pushes into it. */
const channel = <T>() => {
  const items: T[] = [];
  let closed = false;
  let wake: (() => void) | undefined;
  const rouse = () => {
    wake?.();
    wake = undefined;
  };

  return {
    push: (item: T) => {
      if (closed) return;
      items.push(item);
      rouse();
    },
    close: () => {
      closed = true;
      rouse();
    },
    async *[Symbol.asyncIterator](): AsyncGenerator<T> {
      for (;;) {
        if (items.length > 0) {
          yield items.shift() as T;
          continue;
        }
        if (closed) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
};

const execInputOf = (
  message: Pick<
    ExecInputMessage,
    'cmd' | 'cwd' | 'env' | 'user' | 'timeoutMs' | 'tty'
  >,
): SandboxExecInput => ({
  cmd: [...message.cmd],
  ...(message.cwd === undefined ? {} : { cwd: message.cwd }),
  ...(message.env.length === 0 ? {} : { env: [...message.env] }),
  ...(message.user === undefined ? {} : { user: message.user }),
  ...(message.timeoutMs === undefined ? {} : { timeoutMs: message.timeoutMs }),
  ...(message.tty === undefined ? {} : { tty: message.tty }),
});

const execResultMessage = (result: SandboxExecResult) =>
  create(SandboxExecResultSchema, {
    ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutBytes: result.stdoutBytes,
    stderrBytes: result.stderrBytes,
  });

/** The fake `sandbox/v1` provider. */
export const fakeSandboxProvider = (
  options: FakeSandboxProviderOptions = {},
): FakeSandboxProvider => {
  const record = options.record ?? {
    acquired: [],
    discarded: [],
    released: 0,
  };
  const log = options.log ?? (() => undefined);
  const live = new Map<
    string,
    { readonly sandbox: Sandbox; readonly release: () => Promise<void> }
  >();
  const operations: FakeLeaseOperation[] = [];
  const putFiles: FakePutFile[] = [];
  const starts: FakeStart[] = [];
  let leases = 0;

  /** Records the operation, then answers the lease's sandbox or fails `unknown_lease`. */
  const leaseOf = async (
    method: string,
    leaseId: string,
    context: HandlerContext,
  ): Promise<Sandbox> => {
    operations.push({ method, leaseId, signal: context.signal });
    await options.beforeOperation?.({ method, leaseId });
    const lease = live.get(leaseId);
    if (lease === undefined)
      throw new ContractError('unknown_lease', `No lease ${leaseId}.`);

    return lease.sandbox;
  };

  const implementation: Partial<ServiceImpl<typeof SandboxService>> = {
    describe: () => ({ provider: 'fake', durableWorkspace: true }),
    acquire: async (request, context) => {
      log('sandbox.acquire', { identity: request.identity });
      record.acquired.push(request.identity);
      const leaseId = `lease-${++leases}`;
      if (options.acquire !== undefined) {
        const lease = await options.acquire({
          identity: request.identity,
          signal: context.signal,
        });
        live.set(leaseId, {
          sandbox: lease.sandbox as unknown as Sandbox,
          release: async () => {
            await lease.release();
          },
        });
      } else {
        live.set(leaseId, {
          sandbox: options.sandbox ?? defaultSandbox,
          release: async () => {
            await options.release?.();
          },
        });
      }
      const { sandbox } = live.get(leaseId) as { readonly sandbox: Sandbox };

      return { leaseId, sandboxId: sandbox.id, root: sandbox.root };
    },
    release: async (request) => {
      log('sandbox.release', { leaseId: request.leaseId });
      const lease = live.get(request.leaseId);
      if (lease === undefined) return {};
      live.delete(request.leaseId);
      record.released += 1;
      await lease.release();

      return {};
    },
    discard: async (request) => {
      log('sandbox.discard', { identity: request.identity });
      record.discarded.push(request.identity);
      await options.discard?.(request.identity);

      return {};
    },
    machines: () => ({ machines: [] }),
    machine: () => ({}),
    exec: async (request, context) => {
      log('sandbox.exec', toJson(ExecRequestSchema, request));
      const sandbox = await leaseOf('exec', request.leaseId, context);
      if (request.request === undefined)
        throw new ContractError('invalid_input', 'No request.');
      const result = await sandbox.exec({
        ...execInputOf(request.request),
        signal: context.signal,
      });

      return { response: execResultMessage(result) };
    },
    readFile: async (request, context) => {
      log('sandbox.readFile', toJson(ReadFileRequestSchema, request));
      const sandbox = await leaseOf('readFile', request.leaseId, context);

      return {
        response: {
          content: await sandbox.readFile(request.request?.path ?? ''),
        },
      };
    },
    writeFile: async (request, context) => {
      log('sandbox.writeFile', toJson(WriteFileRequestSchema, request));
      const sandbox = await leaseOf('writeFile', request.leaseId, context);
      await sandbox.writeFile(
        request.request?.path ?? '',
        request.request?.content ?? '',
      );

      return {};
    },
    diff: async (request, context) => {
      log('sandbox.diff', toJson(DiffRequestSchema, request));
      const sandbox = await leaseOf('diff', request.leaseId, context);
      const input = request.request;
      const diff = await sandbox.diff(
        input === undefined
          ? undefined
          : {
              ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
              ...(input.paths.length === 0 ? {} : { paths: [...input.paths] }),
            },
      );

      return { response: { diff } };
    },
    cloneRepo: async (request, context) => {
      log('sandbox.cloneRepo', toJson(CloneRepoRequestSchema, request));
      const sandbox = await leaseOf('cloneRepo', request.leaseId, context);
      const input = request.request;
      const auth = input?.auth?.kind;
      const cloned = await sandbox.cloneRepo({
        url: input?.url ?? '',
        ...(input?.directory === undefined
          ? {}
          : { directory: input.directory }),
        ...(input?.branch === undefined ? {} : { branch: input.branch }),
        ...(input?.commit === undefined ? {} : { commit: input.commit }),
        ...(input?.timeoutMs === undefined
          ? {}
          : { timeoutMs: input.timeoutMs }),
        ...(auth?.case === 'token'
          ? {
              auth: {
                kind: 'token' as const,
                token: auth.value.token,
                ...(auth.value.username === undefined
                  ? {}
                  : { username: auth.value.username }),
              },
            }
          : auth?.case === 'basic'
            ? {
                auth: {
                  kind: 'basic' as const,
                  username: auth.value.username,
                  password: auth.value.password,
                },
              }
            : {}),
      });

      return { response: { path: cloned.path, commit: cloned.commit } };
    },
    stats: async (request, context) => {
      log('sandbox.stats', { leaseId: request.leaseId });
      const sandbox = await leaseOf('stats', request.leaseId, context);
      const stats = await sandbox.stats?.();

      return stats === undefined
        ? {}
        : { response: create(SandboxStatsSchema, stats) };
    },
    ssh: async (request, context) => {
      log('sandbox.ssh', { leaseId: request.leaseId });
      const sandbox = await leaseOf('ssh', request.leaseId, context);
      const ssh = await sandbox.ssh();

      return ssh === undefined
        ? {}
        : { response: create(SandboxSshAccessSchema, ssh) };
    },
    async *getFile(request, context) {
      log('sandbox.getFile', { leaseId: request.leaseId });
      const sandbox = await leaseOf('getFile', request.leaseId, context);
      const bytes = await sandbox.getFile(request.request?.path ?? '');
      for (const chunk of chunkBytes(bytes)) yield { chunk };
    },
    putFile: async (requests, context) => {
      let call: FakePutFile | undefined;
      const chunks: Uint8Array[] = [];
      for await (const { item } of requests) {
        if (call === undefined) {
          if (item.case !== 'head')
            throw new ContractError(
              'invalid_input',
              'PutFile needs a head first.',
            );
          log('sandbox.putFile', { leaseId: item.value.leaseId });
          call = {
            leaseId: item.value.leaseId,
            path: item.value.request?.path ?? '',
            chunks: [],
          };
          putFiles.push(call);
          continue;
        }
        if (item.case !== 'chunk')
          throw new ContractError('invalid_input', 'PutFile takes one head.');
        call.chunks.push(item.value.length);
        chunks.push(item.value);
      }
      if (call === undefined)
        throw new ContractError('invalid_input', 'PutFile needs a head first.');
      const sandbox = await leaseOf('putFile', call.leaseId, context);
      call.written = joinChunks(chunks);
      await sandbox.putFile(call.path, call.written);

      return {};
    },
    async *start(requests, context) {
      const iterator = requests[Symbol.asyncIterator]();
      const first = await iterator.next();
      if (first.done === true || first.value.item.case !== 'head')
        throw new ContractError('invalid_input', 'Start needs a head first.');
      const { leaseId, request } = first.value.item.value;
      log('sandbox.start', { leaseId });
      const sandbox = await leaseOf('start', leaseId, context);
      if (sandbox.start === undefined)
        throw new ContractError(
          'unsupported_operation',
          'This sandbox cannot start processes.',
        );
      const call: FakeStart = {
        leaseId,
        cmd: [...(request?.cmd ?? [])],
        signal: context.signal,
        requests: [],
      };
      starts.push(call);
      const outputs = channel<SandboxProcessOutput>();
      const process = await sandbox.start({
        ...(request === undefined ? { cmd: [] } : execInputOf(request)),
        ...(request?.cols === undefined ? {} : { cols: request.cols }),
        ...(request?.rows === undefined ? {} : { rows: request.rows }),
        onOutput: (output) => outputs.push(output),
      });
      const terminate = () => {
        void process.terminate();
        outputs.close();
      };
      context.signal.addEventListener('abort', terminate, { once: true });
      void (async () => {
        for (;;) {
          const next = await iterator.next();
          if (next.done === true) return;
          const { item } = next.value;
          if (item.case === 'write') {
            call.requests.push({ write: item.value });
            await process.write(item.value);
          } else if (item.case === 'resize') {
            call.requests.push({ resize: [item.value.cols, item.value.rows] });
            await process.resize(item.value.cols, item.value.rows);
          }
        }
      })().catch(() => undefined);
      void process.result.then(outputs.close, outputs.close);
      try {
        for await (const output of outputs)
          yield { item: { case: 'output' as const, value: output } };
        yield {
          item: {
            case: 'exit' as const,
            value: execResultMessage(await process.result),
          },
        };
      } finally {
        context.signal.removeEventListener('abort', terminate);
      }
    },
  };

  return {
    entry: [SandboxService, implementation] as unknown as ServiceEntry,
    record,
    operations,
    putFiles,
    starts,
    leases: () => [...live.keys()],
    drop: (leaseId) => {
      live.delete(leaseId);
    },
  };
};

// ---------------------------------------------------------------------------
// Sandboxes the S47a cases lease

export const MiB = 1024 * 1024;

/** 2.5 MiB of a repeating, non-text pattern. */
export const largeFile = () =>
  Uint8Array.from({ length: 2.5 * MiB }, (_, index) => index % 251);

/** Bytes that are not the UTF-8 of their text field, so a copy is observable. */
export const rawStdout = Uint8Array.from([0xff, 0x00, 0x7f]);
export const rawStderr = Uint8Array.from([0xfe]);

const emptyResult = (): SandboxExecResult => ({
  exitCode: null,
  stdout: '',
  stderr: '',
  stdoutBytes: new Uint8Array(),
  stderrBytes: new Uint8Array(),
});

/** One process a startable sandbox started, with the controls a case drives. */
export interface StartedProcess {
  readonly input: SandboxProcessInput;
  readonly writes: string[];
  readonly resizes: (readonly [number, number])[];
  terminated: boolean;
  finish(result: SandboxExecResult): void;
}

export interface RecordingSandboxOptions {
  readonly id?: string;
  readonly root?: string;
  /** What `stats()` answers; the sandbox has no `stats` without it. */
  readonly stats?: SandboxStats;
  readonly ssh?: SandboxSshAccess;
  /** Gives the sandbox a `start` whose processes the case drives. */
  readonly startable?: boolean;
}

/**
 * A sandbox that records what reaches it and answers fixed values:
 * - `exec`: `cmd[0] === 'killed'` answers no exit code; `'hold'` waits until
 *   the exec's signal aborts, then answers no exit code; anything else exits
 *   3 with `out`/`err` and the raw byte fields;
 * - `readFile(path)` answers `content of <path>`; `putFile`/`getFile` keep
 *   files in memory; `diff` answers a fixed diff; `cloneRepo` a fixed clone.
 */
export const recordingSandbox = (options: RecordingSandboxOptions = {}) => {
  const files = new Map<string, Uint8Array>();
  const seen = {
    execs: [] as SandboxExecInput[],
    writes: [] as (readonly [string, string])[],
    puts: [] as (readonly [string, Uint8Array])[],
    diffs: [] as (SandboxDiffInput | undefined)[],
    clones: [] as CloneRepoInput[],
  };
  const processes: StartedProcess[] = [];
  const start = async (input: SandboxProcessInput): Promise<SandboxProcess> => {
    let finish: (result: SandboxExecResult) => void = () => undefined;
    const result = new Promise<SandboxExecResult>((resolve) => {
      finish = resolve;
    });
    const started: StartedProcess = {
      input,
      writes: [],
      resizes: [],
      terminated: false,
      finish,
    };
    processes.push(started);

    return {
      result,
      write: async (data) => {
        started.writes.push(data);
      },
      resize: async (cols, rows) => {
        started.resizes.push([cols, rows]);
      },
      terminate: async () => {
        started.terminated = true;
        finish(emptyResult());
      },
    };
  };
  const sandbox: Sandbox = {
    id: options.id ?? 'vm-3',
    root: options.root ?? '/work',
    exec: async (input): Promise<SandboxExecResult> => {
      seen.execs.push(input);
      if (input.cmd[0] === 'hold') {
        await new Promise<void>((resolve) => {
          if (input.signal?.aborted === true) resolve();
          input.signal?.addEventListener('abort', () => resolve(), {
            once: true,
          });
        });
        return emptyResult();
      }
      return input.cmd[0] === 'killed'
        ? { ...emptyResult(), stderr: 'killed', stderrBytes: rawStderr }
        : {
            exitCode: 3,
            stdout: 'out',
            stderr: 'err',
            stdoutBytes: rawStdout,
            stderrBytes: rawStderr,
          };
    },
    readFile: async (path) => `content of ${path}`,
    writeFile: async (path, content) => {
      seen.writes.push([path, content]);
    },
    putFile: async (path, bytes) => {
      seen.puts.push([path, bytes]);
      files.set(path, bytes);
    },
    getFile: async (path) => files.get(path) ?? new Uint8Array(),
    diff: async (input) => {
      seen.diffs.push(input);
      return 'diff --git a/x b/x';
    },
    cloneRepo: async (input) => {
      seen.clones.push(input);
      return { path: '/work/repo', commit: 'abc123' };
    },
    ssh: async () => options.ssh,
    ...(options.stats === undefined
      ? {}
      : { stats: async () => options.stats }),
    ...(options.startable === true ? { start } : {}),
  };

  return { sandbox, files, seen, processes };
};
