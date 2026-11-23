// The `firecracker` host part's `sandbox/v1` served through the test router as
// `src/host/main.ts` serves it (phase 3, S44): `createSandboxService` over
// `firecrackerSandboxBinding`, with `instances.onGone` captured, since the test
// router sends no `InstanceGone` (as core's tests do), and a fake sandbox
// provider in place of Firecracker.

import assert from 'node:assert/strict';

import { Code, ConnectError } from '@connectrpc/connect';
import { ContractError, fromConnectError } from 'bundle/contracts';
import type { BundleInstance } from 'bundle/host';
import { createTestRouter } from 'bundle/testing';
import { SandboxService } from 'runtime/contracts/gen/doric/sandbox/v1/sandbox_pb.js';
import type {
  SandboxExecInput,
  SandboxExecResult,
  SandboxProcessInput,
  SandboxProcessOutput,
  SandboxProvider,
  SandboxProvisionInput,
  SandboxRuntime,
  SandboxSshAccess,
  SandboxStats,
} from 'sandbox';
import type { Sandpool } from 'sandpool';

import { firecrackerSandboxBinding } from '../../src/host/sandbox.js';
import {
  createSandboxService,
  type SandboxPoolBinding,
} from '../../src/host/service.js';

/** One process a fake sandbox started, driven by the test. */
export interface FakeProcess {
  readonly sandboxId: string;
  readonly input: SandboxProcessInput;
  /** `write:<data>` and `resize:<cols>x<rows>`, in the order they arrived. */
  readonly events: string[];
  terminated: boolean;
  /** Emits one output chunk, as the process would. */
  output(stream: 'stdout' | 'stderr', data: string): void;
  /** Ends the process with `result`. */
  finish(result: SandboxExecResult): void;
}

/** What a fake sandbox answers; every field is optional. */
export interface FakeBehavior {
  /** Answers each exec; default exit 0 with empty output. */
  readonly exec?: (input: SandboxExecInput) => SandboxExecResult;
  readonly files?: Map<string, Uint8Array>;
  readonly ssh?: SandboxSshAccess;
  readonly stats?: SandboxStats;
  /** Holds every provisioning until it resolves. */
  readonly provisioning?: Promise<void>;
}

export const execResult = (
  fields: Partial<SandboxExecResult> = {},
): SandboxExecResult => ({
  exitCode: 0,
  stdout: '',
  stderr: '',
  stdoutBytes: new Uint8Array(),
  stderrBytes: new Uint8Array(),
  ...fields,
});

/** A sandbox provider whose sandboxes record what reaches them. */
export const fakeProvider = (behavior: FakeBehavior = {}) => {
  const provisioned: SandboxProvisionInput[] = [];
  const disposed: string[] = [];
  const execs: { readonly sandboxId: string; readonly input: SandboxExecInput }[] = [];
  const puts: { readonly sandboxId: string; readonly path: string; readonly bytes: Uint8Array }[] = [];
  const processes: FakeProcess[] = [];
  const files = behavior.files ?? new Map<string, Uint8Array>();
  let next = 1;

  const runtime = (id: string): SandboxRuntime => ({
    id,
    exec: async (input) => {
      execs.push({ sandboxId: id, input });

      return behavior.exec?.(input) ?? execResult();
    },
    start: async (input) => {
      let settle!: (result: SandboxExecResult) => void;
      const result = new Promise<SandboxExecResult>((resolve) => {
        settle = resolve;
      });
      const process: FakeProcess = {
        sandboxId: id,
        input,
        events: [],
        terminated: false,
        output: (stream, data) => {
          const chunk: SandboxProcessOutput = { stream, data };
          input.onOutput?.(chunk);
        },
        finish: (value) => settle(value),
      };

      processes.push(process);

      return {
        result,
        write: async (data) => {
          process.events.push(`write:${data}`);
        },
        resize: async (cols, rows) => {
          process.events.push(`resize:${String(cols)}x${String(rows)}`);
        },
        terminate: async () => {
          process.terminated = true;
        },
      };
    },
    ...(behavior.stats === undefined
      ? {}
      : { stats: async () => behavior.stats as SandboxStats }),
    putFile: async (path, bytes) => {
      puts.push({ sandboxId: id, path, bytes: new Uint8Array(bytes) });
      files.set(path, new Uint8Array(bytes));
    },
    getFile: async (path) => {
      const bytes = files.get(path);

      if (bytes === undefined) {
        throw new Error(`No such file: ${path}`);
      }

      return bytes;
    },
    ssh: async () => behavior.ssh,
    dispose: async () => {
      disposed.push(id);
    },
  });

  const provider: SandboxProvider = {
    provision: async (input) => {
      provisioned.push(input);
      const id = `vm-${String(next++)}`;

      await behavior.provisioning;

      return runtime(id);
    },
  };

  return { provider, provisioned, disposed, execs, puts, processes, files };
};

export type FakeSandboxes = ReturnType<typeof fakeProvider>;

/** The caller of one instance; the test router gives every caller incarnation 1. */
export const callerOf = (bundleId: string, generation = 1) => ({
  bundleId,
  version: '0.0.0',
  generation,
});

/** Serves the bundle's `sandbox/v1` over `fake` on a fresh test router. */
export const serveFirecracker = async (
  fake: FakeSandboxes,
  options: {
    /** Changes the binding activation built, for sandboxes it cannot make. */
    readonly adjust?: (binding: SandboxPoolBinding) => SandboxPoolBinding;
    /** Leaves the binding unset, as before `activate` set it up. */
    readonly unbound?: boolean;
  } = {},
) => {
  const router = createTestRouter({ instance: { bundleId: 'firecracker' } });
  const goneHandlers: ((instance: BundleInstance) => void)[] = [];
  let binding: SandboxPoolBinding | undefined;

  const sandbox = createSandboxService(() => {
    if (binding === undefined) {
      throw new ContractError('unavailable', 'The sandbox pool is not ready.');
    }

    return binding;
  });

  await router.activate({
    services: [[SandboxService, sandbox.implementation]],
    activate: (context) => {
      if (options.unbound === true) {
        return;
      }

      const built = firecrackerSandboxBinding(
        { environment: {}, client: () => fake.provider },
        context.log,
      );

      binding = options.adjust?.(built) ?? built;

      const handler = (instance: BundleInstance) => sandbox.dropInstance(instance);

      goneHandlers.push(handler);
      context.instances.onGone(handler);
    },
    deactivate: async () => {
      await sandbox.releaseAll();
      await binding?.pool.dispose();
    },
  });

  return {
    router,
    sandbox,
    /** The pool activation built, for its status. */
    pool: (): Sandpool => {
      assert.ok(binding !== undefined, 'not activated');

      return binding.pool;
    },
    client: (caller = callerOf('runtime')) =>
      router.client(SandboxService, { caller }),
    /** Delivers `InstanceGone` for `caller`'s instance, as the router would. */
    gone: (caller: { readonly bundleId: string; readonly generation: number }) => {
      for (const handler of goneHandlers) {
        handler({
          bundleId: caller.bundleId,
          generation: caller.generation,
          incarnation: 1,
        });
      }
    },
    stop: () => router.control.stop(),
  };
};

/** Asserts a call failed with the gRPC code and the Doric code given. */
export const failsWith =
  (grpc: Code, code: string) =>
  (error: unknown): boolean => {
    assert.ok(error instanceof ConnectError, String(error));
    assert.equal(error.code, grpc, `${Code[error.code]}: ${error.rawMessage}`);
    assert.equal(fromConnectError(error).code, code, error.rawMessage);

    return true;
  };

/** Resolves once `predicate` holds; fails after `timeoutMs`. */
export const eventually = async (
  predicate: () => boolean,
  message: string,
  timeoutMs = 2_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;

  while (!predicate()) {
    if (Date.now() > deadline) {
      assert.fail(`timed out: ${message}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

/** A request stream the test writes to and closes. */
export const requestStream = <T>() => {
  const items: T[] = [];
  let closed = false;
  let wake: (() => void) | undefined;

  const iterable: AsyncIterable<T> = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        const item = items.shift();

        if (item !== undefined) {
          yield item;
          continue;
        }

        if (closed) {
          return;
        }

        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };

  return {
    iterable,
    push(item: T) {
      items.push(item);
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
  };
};

/** Reads every item of a response stream; rejects as the stream does. */
export const collect = async <T>(stream: AsyncIterable<T>): Promise<T[]> => {
  const items: T[] = [];

  for await (const item of stream) {
    items.push(item);
  }

  return items;
};

/** The concatenation of byte arrays. */
export const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;

  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }

  return out;
};

/** `size` bytes of a repeating, position-dependent pattern. */
export const patterned = (size: number): Uint8Array => {
  const bytes = new Uint8Array(size);

  for (let index = 0; index < size; index += 1) {
    bytes[index] = (index * 31 + 7) % 251;
  }

  return bytes;
};

/** `pool` whose sandboxes offer no `start`, as a provider without live processes. */
export const withoutStart = (pool: Sandpool): Sandpool => ({
  heated: () => pool.heated(),
  waitUntilHeated: (options) => pool.waitUntilHeated(options),
  status: () => pool.status(),
  dispose: () => pool.dispose(),
  acquire: async (options) => {
    const lease = await pool.acquire(options);
    const { start: _start, ...sandbox } = lease.sandbox;

    return { sandbox, release: lease.release };
  },
});
