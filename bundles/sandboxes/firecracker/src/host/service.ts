// `sandbox/v1` 1.1.0 by lease id (spec `docs/designs/grpc-processes.md`,
// "Sandbox leases"; phase 3, slice S44).

import { randomUUID } from 'node:crypto';

import type { HandlerContext, ServiceImpl } from '@connectrpc/connect';
import { ContractError } from 'bundle/contracts';
import { type BundleInstance, stampedCallerOf } from 'bundle/host';
import type {
  GitAuth as GitAuthMessage,
  SandboxExecInput as ExecInputMessage,
  SandboxService,
  StartRequest,
} from 'runtime/contracts/gen/doric/sandbox/v1/sandbox_pb.js';
import type {
  GitAuth,
  RunningVm,
  Sandbox,
  SandboxExecInput,
  SandboxExecResult,
  SandboxProcess,
  SandboxProcessOutput,
  VmRegistry,
} from 'sandbox';
import type { SandboxLease, Sandpool } from 'sandpool';

/** What the service runs on, set up at `activate`. */
export interface SandboxPoolBinding {
  readonly pool: Sandpool;
  readonly vms: VmRegistry;
  /** `Describe`'s answer: `docker` / `true`, `firecracker` / `false`. */
  readonly description: {
    readonly provider: string;
    readonly durableWorkspace: boolean;
  };
  /** Discards a deleted Project's durable workspace; a no-op for Firecracker. */
  readonly discard: (identity: string) => Promise<void>;
}

export interface SandboxServiceHandle {
  readonly implementation: ServiceImpl<typeof SandboxService>;
  /**
   * Releases every lease `instance` acquired (same bundle id, generation and
   * incarnation), as `Release` would, for `context.instances.onGone`. Its
   * later operations fail with `unknown_lease`. Never throws; a failed
   * release is logged at `error` and still forgets the lease.
   */
  dropInstance(instance: BundleInstance): void;
  /**
   * Releases every lease, for `deactivate`, before the pool is disposed.
   * Resolves when each release settled; never rejects.
   */
  releaseAll(): Promise<void>;
}

/**
 * `sandbox/v1` over a sandbox pool, by lease id.
 *
 * `bind()` answers the binding `activate` set up. Every RPC fails with
 * `unavailable` while it throws (before `activate`). Building the handle
 * makes no I/O.
 *
 * Leases. `Acquire({ identity })` calls `pool.acquire({ identity, signal })`
 * with the call's signal. It answers `{ leaseId, sandboxId: sandbox.id, root }`
 * with a new, unguessable `leaseId`, owned by the calling instance
 * (`stampedCallerOf`). If the call was cancelled by the time the pool answered,
 * the lease is released and nothing is kept. `Release({ leaseId })` releases
 * the owner's lease once. An unknown, already released or other instance's
 * lease is a no-op, and another instance's lease stays held. Release does not
 * end a `Start` stream already open on the lease.
 *
 * Operations. `Exec`, `Start`, `Stats`, `CloneRepo`, `ReadFile`, `WriteFile`,
 * `PutFile`, `GetFile`, `Diff` and `Ssh` run on the lease's sandbox. A
 * `leaseId` that is unknown, released, or owned by another instance fails with
 * `NOT_FOUND`, reason `unknown_lease`, and touches no sandbox. Each operation
 * maps one-to-one onto today's `Sandbox` method:
 * - absent fields stay absent;
 * - `exitCode: null` is an absent `exit_code`;
 * - `Stats` and `Ssh` answer no `response` when the sandbox has none;
 * - `Exec`'s call signal is the exec's `signal`.
 * `PutFile` reads a `head`, then the chunks, and writes the bytes once when
 * the stream ends; a stream that does not start with one head fails with
 * `invalid_input`. `GetFile` answers the bytes in chunks of at most 1 MiB, and
 * no item for an empty file. A failure of the sandbox fails the call with its
 * error (`internal` unless it is a `ContractError`).
 *
 * `Start`. The first item must be `head`; otherwise the call fails with
 * `invalid_input` and nothing starts. A sandbox without `start` fails with
 * `UNIMPLEMENTED` (`unsupported_operation`). Then each `write` is written to
 * stdin and each `resize` resizes the terminal, in order. Answers one `output`
 * item per output chunk, in order, then one `exit` item with the process's
 * result, then ends. The client half-closing its side does not stop the
 * process. Cancelling the call terminates the process tree. A `write` or
 * `resize` after the exit is ignored.
 *
 * `Describe`, `Discard`, `Machines` and `Machine` answer as today
 * (`binding.description`, `binding.discard`, `vms.list()`, `vms.find(id)`;
 * `Machine` answers no `runningMachine` for an unknown id). They need no lease.
 */
export const createSandboxService = (
  bind: () => SandboxPoolBinding,
): SandboxServiceHandle => {
  const leases = new Map<string, HeldLease>();

  /** The lease `leaseId` names when the calling instance owns it. */
  const leaseOf = (context: HandlerContext, leaseId: string): Sandbox => {
    bind();
    const held = leases.get(leaseId);

    if (held === undefined || held.owner !== ownerOf(context)) {
      throw new ContractError('unknown_lease', `No lease ${leaseId}.`);
    }

    return held.lease.sandbox;
  };

  /** Forgets `leaseId` and releases its sandbox; logs a failed release. */
  const release = async (leaseId: string, held: HeldLease): Promise<void> => {
    leases.delete(leaseId);

    try {
      await held.lease.release();
    } catch (error) {
      console.error(`Releasing sandbox lease ${leaseId} failed:`, error);
    }
  };

  const implementation: ServiceImpl<typeof SandboxService> = {
    describe: async () => ({ ...bind().description }),
    acquire: async ({ identity }, context) => {
      const { pool } = bind();
      const lease = await pool.acquire({ identity, signal: context.signal });

      if (context.signal.aborted) {
        await lease.release();
        throw new ContractError('unavailable', 'The acquisition was cancelled.');
      }

      const leaseId = randomUUID();

      leases.set(leaseId, { owner: ownerOf(context), lease });

      return {
        leaseId,
        sandboxId: lease.sandbox.id,
        root: lease.sandbox.root,
      };
    },
    release: async ({ leaseId }, context) => {
      bind();
      const held = leases.get(leaseId);

      if (held !== undefined && held.owner === ownerOf(context)) {
        await release(leaseId, held);
      }

      return {};
    },
    discard: async ({ identity }) => {
      await bind().discard(identity);

      return {};
    },
    machines: async () => ({
      machines: bind().vms.list().map(machineOf),
    }),
    machine: async ({ id }) => runningMachineOf(bind().vms.find(id)),
    exec: async ({ leaseId, request }, context) => {
      const sandbox = leaseOf(context, leaseId);
      const result = await sandbox.exec({
        ...execInputOf(required(request)),
        signal: context.signal,
      });

      return { response: execResultOf(result) };
    },
    start: (requests, context) => {
      bind();

      return startProcess(requests, context, leaseOf);
    },
    stats: async ({ leaseId }, context) => {
      const stats = await leaseOf(context, leaseId).stats?.();

      return stats === undefined ? {} : { response: { ...stats } };
    },
    cloneRepo: async ({ leaseId, request }, context) => {
      const sandbox = leaseOf(context, leaseId);
      const input = required(request);
      const { path, commit } = await sandbox.cloneRepo({
        url: input.url,
        ...optional('directory', input.directory),
        ...optional('branch', input.branch),
        ...optional('commit', input.commit),
        ...optional('auth', gitAuthOf(input.auth)),
        ...optional('timeoutMs', input.timeoutMs),
      });

      return { response: { path, commit } };
    },
    readFile: async ({ leaseId, request }, context) => {
      const sandbox = leaseOf(context, leaseId);
      const content = await sandbox.readFile(required(request).path);

      return { response: { content } };
    },
    writeFile: async ({ leaseId, request }, context) => {
      const sandbox = leaseOf(context, leaseId);
      const { path, content } = required(request);

      await sandbox.writeFile(path, content);

      return {};
    },
    putFile: async (requests, context) => {
      bind();
      let target: { readonly sandbox: Sandbox; readonly path: string } | undefined;
      const chunks: Uint8Array[] = [];

      for await (const { item } of requests) {
        if (target === undefined) {
          if (item.case !== 'head') {
            throw new ContractError(
              'invalid_input',
              'A PutFile stream begins with one head.',
            );
          }

          target = {
            sandbox: leaseOf(context, item.value.leaseId),
            path: required(item.value.request).path,
          };
        } else if (item.case === 'chunk') {
          chunks.push(item.value);
        } else {
          throw new ContractError(
            'invalid_input',
            'A PutFile stream carries one head, then chunks.',
          );
        }
      }

      if (target === undefined) {
        throw new ContractError('invalid_input', 'A PutFile stream begins with one head.');
      }

      await target.sandbox.putFile(target.path, concat(chunks));

      return {};
    },
    getFile: async function* ({ leaseId, request }, context) {
      const sandbox = leaseOf(context, leaseId);
      const bytes = await sandbox.getFile(required(request).path);

      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        yield { chunk: bytes.subarray(offset, offset + chunkSize) };
      }
    },
    diff: async ({ leaseId, request }, context) => {
      const sandbox = leaseOf(context, leaseId);
      const diff = await sandbox.diff(
        request === undefined
          ? undefined
          : {
              ...optional('cwd', request.cwd),
              ...(request.paths.length === 0 ? {} : { paths: [...request.paths] }),
            },
      );

      return { response: { diff } };
    },
    ssh: async ({ leaseId }, context) => {
      const access = await leaseOf(context, leaseId).ssh();

      return access === undefined ? {} : { response: { ...access } };
    },
  };

  return {
    implementation,
    dropInstance: (instance) => {
      const owner = instanceKey(instance);

      for (const [leaseId, held] of leases) {
        if (held.owner === owner) {
          void release(leaseId, held);
        }
      }
    },
    releaseAll: async () => {
      await Promise.all(
        [...leases].map(([leaseId, held]) => release(leaseId, held)),
      );
    },
  };
};

/** The most bytes one `GetFile` item carries: 1 MiB. */
const chunkSize = 1024 * 1024;

/** A lease the service holds for the instance that acquired it. */
interface HeldLease {
  /** The owning instance, as {@link instanceKey} names it. */
  readonly owner: string;
  readonly lease: SandboxLease;
}

/** One instance: `<bundleId>/<generation>/<incarnation>`. */
const instanceKey = (instance: BundleInstance): string =>
  `${instance.bundleId}/${String(instance.generation)}/${String(instance.incarnation)}`;

/** The instance that made the call `context` serves. */
const ownerOf = (context: HandlerContext): string =>
  instanceKey(stampedCallerOf(context));

/** `value`, which the proto requires, or `invalid_input` when absent. */
const required = <T>(value: T | undefined): T => {
  if (value === undefined) {
    throw new ContractError('invalid_input', 'The request is missing.');
  }

  return value;
};

/** `{ [key]: value }`, or nothing when `value` is absent. */
const optional = <K extends string, V>(
  key: K,
  value: V | undefined,
): { [P in K]?: V } =>
  (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };

const machineOf = ({ id, provider }: RunningVm) => ({ id, provider });

/** `Machine`'s answer: no `runningMachine` for an unknown id. */
const runningMachineOf = (machine: RunningVm | undefined) =>
  machine === undefined ? {} : { runningMachine: machineOf(machine) };

const execInputOf = (
  input: Omit<ExecInputMessage, '$typeName'>,
): SandboxExecInput => ({
  cmd: [...input.cmd],
  ...optional('cwd', input.cwd),
  ...(input.env.length === 0 ? {} : { env: [...input.env] }),
  ...optional('user', input.user),
  ...optional('timeoutMs', input.timeoutMs),
  ...optional('tty', input.tty),
});

const execResultOf = (result: SandboxExecResult) => ({
  ...optional('exitCode', result.exitCode ?? undefined),
  stdout: result.stdout,
  stderr: result.stderr,
  stdoutBytes: result.stdoutBytes,
  stderrBytes: result.stderrBytes,
});

const gitAuthOf = (auth: GitAuthMessage | undefined): GitAuth | undefined => {
  switch (auth?.kind.case) {
    case 'token':
      return {
        kind: 'token',
        token: auth.kind.value.token,
        ...optional('username', auth.kind.value.username),
      };
    case 'basic':
      return {
        kind: 'basic',
        username: auth.kind.value.username,
        password: auth.kind.value.password,
      };
    default:
      return undefined;
  }
};

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const bytes = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;

  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }

  return bytes;
};

/**
 * The error a failed `start` fails the call with: a provider that does not
 * support live processes answers `unsupported_operation` (`UNIMPLEMENTED`).
 */
const startError = (error: unknown): unknown =>
  error instanceof Error &&
  !(error instanceof ContractError) &&
  /does not support live processes/.test(error.message)
    ? new ContractError('unsupported_operation', error.message)
    : error;

/** What a running `Start` call answers next. */
type StartEvent =
  | { readonly kind: 'output'; readonly output: SandboxProcessOutput }
  | { readonly kind: 'exit'; readonly result: SandboxExecResult }
  | { readonly kind: 'failed'; readonly error: unknown }
  | { readonly kind: 'cancelled' };

/** `Start`: one process on the head's lease, relayed both ways. */
async function* startProcess(
  requests: AsyncIterable<StartRequest>,
  context: HandlerContext,
  leaseOf: (context: HandlerContext, leaseId: string) => Sandbox,
): AsyncGenerator<{
  item:
    | { case: 'output'; value: SandboxProcessOutput }
    | { case: 'exit'; value: ReturnType<typeof execResultOf> };
}> {
  const iterator = requests[Symbol.asyncIterator]();
  const first = await iterator.next();

  if (first.done === true || first.value.item.case !== 'head') {
    throw new ContractError('invalid_input', 'A Start stream begins with one head.');
  }

  const { leaseId, request } = first.value.item.value;
  const sandbox = leaseOf(context, leaseId);
  const input = required(request);

  if (sandbox.start === undefined) {
    throw new ContractError(
      'unsupported_operation',
      'The sandbox does not support live processes.',
    );
  }

  const events: StartEvent[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  const push = (event: StartEvent) => {
    events.push(event);
    wake?.();
    wake = undefined;
  };

  let running: SandboxProcess;

  try {
    running = await sandbox.start({
      ...execInputOf(input),
      ...optional('cols', input.cols),
      ...optional('rows', input.rows),
      onOutput: (output) => push({ kind: 'output', output }),
    });
  } catch (error) {
    throw startError(error);
  }

  const terminate = () => {
    if (ended) {
      return;
    }

    ended = true;
    running.terminate().catch((error: unknown) => {
      console.error('Terminating a sandbox process failed:', error);
    });
    push({ kind: 'cancelled' });
  };

  running.result.then(
    (result) => {
      // The process is over: later writes and resizes are ignored.
      ended = true;
      push({ kind: 'exit', result });
    },
    (error: unknown) => push({ kind: 'failed', error }),
  );
  context.signal.addEventListener('abort', terminate, { once: true });

  // Writes and resizes reach the process in order; half-closing ends the
  // relay, not the process.
  void (async () => {
    try {
      for (;;) {
        const next = await iterator.next();

        if (next.done === true || ended) {
          return;
        }

        const { item } = next.value;

        if (item.case === 'write') {
          await running.write(item.value);
        } else if (item.case === 'resize') {
          await running.resize(item.value.cols, item.value.rows);
        } else {
          throw new ContractError(
            'invalid_input',
            'A Start stream carries one head, then writes and resizes.',
          );
        }
      }
    } catch (error) {
      if (!ended) {
        push({ kind: 'failed', error });
      }
    }
  })();

  try {
    for (;;) {
      const event = events.shift();

      if (event === undefined) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        continue;
      }

      switch (event.kind) {
        case 'output':
          yield { item: { case: 'output', value: event.output } };
          break;
        case 'exit':
          yield { item: { case: 'exit', value: execResultOf(event.result) } };
          return;
        case 'failed':
          throw event.error;
        case 'cancelled':
          throw new ContractError('unavailable', 'The Start call was cancelled.');
      }
    }
  } finally {
    context.signal.removeEventListener('abort', terminate);
    terminate();
  }
}
