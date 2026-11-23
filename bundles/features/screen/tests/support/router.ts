// The harness of `screen`'s host part through the router (phase 3, slice
// S49b): `screen.sessions/v2` served by `createTestRouter` as
// `src/host/main.ts` serves it, with recording fakes of `runtime.lease/v1`
// (`Describe`, `Exec` over a scripted sandbox) and `screen.relay/v1`
// (`Expose`, `Forget`), and the registrations the part tracked captured by
// wrapping the activated context's `registrations` (the test router never
// replays them), as `runtime/tests/router/support.ts` does.

import type { TestContext } from 'node:test';

import type { DescService } from '@bufbuild/protobuf';
import type { Client, ServiceImpl } from '@connectrpc/connect';
import { type CallScope, callOf, type Log } from 'bundle/contracts';
import type { HostContext, ServiceEntry } from 'bundle/host';
import { createTestRouter } from 'bundle/testing';
import {
  type ExecRequest,
  LeaseService,
} from 'runtime/contracts/gen/doric/runtime/lease/v1/lease_pb.js';
import { RelayService } from 'screen-relay/contracts/gen/doric/screen/relay/v1/relay_pb.js';

import { SessionsService } from '../../src/contracts/gen/doric/screen/sessions/v2/sessions_pb.js';
import {
  createScreenSessionsService,
  type ScreenSessionsServiceHandle,
} from '../../src/host/rpc/sessions.js';
import {
  createScreenSessionManager,
  type ScreenSandbox,
  type ScreenSession,
  type ScreenSessionManager,
} from '../../src/host/session.js';
import { type FakeSandboxState, fakeSandbox } from './sandbox.js';

/** The Project of the router's default scope. */
export const P = 'project-1';
/** A second Project. */
export const P2 = 'project-2';
/** A Thread of {@link P}. */
export const T = 'thread-1';

/** The services `screen`'s host part declares it calls (section D). */
export const REQUIRES = [
  'doric.runtime.lease.v1.LeaseService',
  'doric.screen.relay.v1.RelayService',
];

/** One `Exec` the lease fake received. */
export interface ExecRecord {
  readonly cmd: readonly string[];
  readonly expectSandboxId: string | undefined;
  readonly scope: CallScope | undefined;
}

/** One `Expose` or `Forget` the relay fake received. */
export interface RelayRecord {
  readonly method: 'expose' | 'forget';
  readonly token: string;
  readonly host?: string;
  readonly port?: number;
  readonly scope: CallScope | undefined;
}

/** What the `runtime.lease/v1` fake saw, and how it answers. */
export interface LeaseFake {
  /** The id `Describe` answers; changed by a test to swap sandboxes. */
  sandboxId: string;
  /** The scope of each `Describe`, in order. */
  readonly describes: (CallScope | undefined)[];
  /** The `target.expectSandboxId` of each `Describe`, in order. */
  readonly describeTargets: (string | undefined)[];
  readonly execs: ExecRecord[];
  /** Called before `Describe` answers; a throw fails the call with it. */
  onDescribe: () => void;
  /**
   * Called with the 1-based index of each `Exec` before it runs on the
   * scripted sandbox; a throw fails the call with it.
   */
  onExec: (index: number, cmd: readonly string[]) => void;
}

/** What the `screen.relay/v1` fake saw, and how it answers. */
export interface RelayFake {
  readonly calls: RelayRecord[];
  /** Called before `Expose` answers; a throw fails the call with it. */
  onExpose: (token: string) => void;
  /** Called before `Forget` answers; a throw fails the call with it. */
  onForget: (token: string) => void;
}

/** One registration the part tracked. */
export interface TrackedRecord {
  readonly ref: DescService;
  /** The part's `register`: calling it again is what a replay does. */
  readonly register: (client: unknown) => Promise<unknown>;
  /** Whether the part untracked it. */
  untracked: boolean;
}

/** A fake session manager whose `ensure` the test answers. */
export interface FakeManager {
  /** The sandboxes `ensure` was called with, in order. */
  readonly ensured: ScreenSandbox[];
  /** Answers the next session; default a session per {@link tokens}. */
  readonly manager: (log: Log) => ScreenSessionManager;
  /** Resolves once `ensure` was called `count` times. */
  calledTimes(count: number): Promise<void>;
  /** Releases every gated `ensure`; later ones answer at once. */
  release(): void;
}

/**
 * A fake manager: `ensure` answers `{ display: 100 + n, port: 14500, host:
 * '172.17.0.9', token: tokens[n] }` for its n-th call (0-based; the last
 * token repeats), held until {@link FakeManager.release} when `gated`.
 */
export const fakeManager = (
  tokens: readonly string[],
  gated = false,
): FakeManager => {
  const ensured: ScreenSandbox[] = [];
  const waiters: { readonly count: number; readonly done: () => void }[] = [];
  let open = !gated;
  let opened: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    opened = resolve;
  });

  const notify = () => {
    for (const waiter of waiters) {
      if (ensured.length >= waiter.count) {
        waiter.done();
      }
    }
  };

  return {
    ensured,
    manager: () => ({
      ensure: async (sandbox): Promise<ScreenSession> => {
        const index = ensured.length;

        ensured.push(sandbox);
        notify();

        if (!open) {
          await gate;
        }

        return {
          display: 100 + index,
          port: 14500,
          host: '172.17.0.9',
          token: tokens[Math.min(index, tokens.length - 1)] ?? 'token',
        };
      },
    }),
    calledTimes: (count) =>
      ensured.length >= count
        ? Promise.resolve()
        : new Promise((done) => {
            waiters.push({ count, done });
          }),
    release: () => {
      open = true;
      opened();
    },
  };
};

/** A `[Service, implementation]` fake that serves only the methods given. */
const fakeOf = <S extends DescService>(
  service: S,
  implementation: Partial<ServiceImpl<S>>,
): ServiceEntry => [service, implementation as ServiceImpl<S>] as ServiceEntry;

const execInputOf = (request: ExecRequest) => ({
  cmd: [...(request.request?.cmd ?? [])],
  ...(request.request?.timeoutMs === undefined
    ? {}
    : { timeoutMs: request.request.timeoutMs }),
});

export interface HarnessOptions {
  /** The scripted sandbox behind `Exec`; default `fakeSandbox()`'s. */
  readonly sandbox?: Partial<FakeSandboxState>;
  /**
   * The manager the part builds; default the real
   * `createScreenSessionManager` with `portOpen: async () => true` and a
   * no-op `sleep`.
   */
  readonly manager?: (log: Log) => ScreenSessionManager;
}

/**
 * `screen`'s host part activated on a test router as `main.ts` runs it
 * (`services: [[SessionsService, implementation]]`, `activate`,
 * `deactivate`), scope `{ projectId: P }`, `requires` its two services.
 */
export const harness = async (t: TestContext, options: HarnessOptions = {}) => {
  const scripted = fakeSandbox(options.sandbox);
  const lease: LeaseFake = {
    sandboxId: 'sb-1',
    describes: [],
    describeTargets: [],
    execs: [],
    onDescribe: () => undefined,
    onExec: () => undefined,
  };
  const relay: RelayFake = {
    calls: [],
    onExpose: () => undefined,
    onForget: () => undefined,
  };
  const tracked: TrackedRecord[] = [];
  /** `Expose` answers and `Attach` answers, in the order they happened. */
  const events: string[] = [];

  const fakes = [
    fakeOf(LeaseService, {
      describe: (request, context) => {
        lease.describes.push(callOf(context).scope);
        lease.describeTargets.push(request.target?.expectSandboxId);
        lease.onDescribe();

        return { id: lease.sandboxId, root: '/workspace' };
      },
      exec: async (request, context) => {
        const input = execInputOf(request);

        lease.execs.push({
          cmd: input.cmd,
          expectSandboxId: request.target?.expectSandboxId,
          scope: callOf(context).scope,
        });
        lease.onExec(lease.execs.length, input.cmd);

        const result = await scripted.sandbox.exec(input);

        return {
          response: {
            exitCode: result.exitCode ?? undefined,
            stdout: result.stdout,
            stderr: result.stderr,
            stdoutBytes: result.stdoutBytes,
            stderrBytes: result.stderrBytes,
          },
        };
      },
    }),
    fakeOf(RelayService, {
      expose: (request, context) => {
        relay.calls.push({
          method: 'expose',
          token: request.token,
          host: request.host,
          port: request.port,
          scope: callOf(context).scope,
        });
        relay.onExpose(request.token);
        events.push(`expose ${request.token}`);

        return {};
      },
      forget: (request, context) => {
        relay.calls.push({
          method: 'forget',
          token: request.token,
          scope: callOf(context).scope,
        });
        relay.onForget(request.token);

        return {};
      },
    }),
  ];

  const handle: ScreenSessionsServiceHandle = createScreenSessionsService({
    manager:
      options.manager ??
      ((log) =>
        createScreenSessionManager({
          log: () => log,
          portOpen: async () => true,
          sleep: async () => undefined,
        })),
  });
  const router = createTestRouter({
    fakes,
    requires: REQUIRES,
    scope: { projectId: P },
    instance: { bundleId: 'screen' },
  });
  let context: HostContext | undefined;

  t.after(() => router.control.stop());

  await router.activate({
    services: [[SessionsService, handle.implementation]],
    activate: (activated) => {
      context = activated;

      const registrations: HostContext['registrations'] = {
        ...activated.registrations,
        track: async (ref, register, trackOptions) => {
          const registration = await activated.registrations.track(
            ref,
            register,
            trackOptions,
          );
          const record: TrackedRecord = {
            ref,
            register: register as TrackedRecord['register'],
            untracked: false,
          };

          tracked.push(record);

          const wrapped: typeof registration = {
            get current() {
              return registration.current;
            },
            untrack: () => {
              record.untracked = true;
              registration.untrack();
            },
          };

          return wrapped;
        },
      };

      handle.activate({ ...activated, registrations });
    },
    deactivate: () => handle.deactivate(),
  });

  const contextOf = (): HostContext => {
    if (context === undefined) {
      throw new Error('The part was not activated.');
    }

    return context;
  };

  return {
    router,
    handle,
    lease,
    relay,
    tracked,
    events,
    /** The scripted sandbox's state behind `Exec`. */
    sandbox: scripted.state,
    /** A client of the part with the router's scope, or `scope`. */
    client: (scope?: CallScope): Client<typeof SessionsService> =>
      router.client(SessionsService, scope === undefined ? {} : { scope }),
    /** The registrations still tracked, in tracking order. */
    live: () => tracked.filter((record) => !record.untracked),
    /** A client of `screen.relay/v1` outside any call, as a replay gets. */
    relayClient: () => contextOf().services.use(RelayService),
    /** Exposes and forgets the relay fake saw, as `method token`. */
    relayLog: () => relay.calls.map((call) => `${call.method} ${call.token}`),
  };
};

export type Harness = Awaited<ReturnType<typeof harness>>;
