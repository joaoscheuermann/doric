// The `screen.sessions/v2` provider: `attach` runs the ensure task on the
// calling Project's lease, then publishes the session on the relay and answers
// the host-relative path the window loads. The relay itself belongs to the
// `screen-relay` bundle, which the composition runs resident in the kernel
// because mounting on the host's shared listener takes native handles this
// generation cannot reach; here the session is only published and forgotten
// through `screen.relay/v1`. Lease states map one to one onto the contract's
// answer, and a session that cannot be served reports why instead of failing
// the bridge call.

import type { Log } from 'bundle/contracts';
import { type Call, defineMethod, defineService } from 'bundle/contracts';
import { type RuntimeLease, RuntimeLeaseV1 } from 'runtime/contracts';
import type { ScreenRelay } from 'screen-relay/contracts';

import {
  type ScreenAttach,
  ScreenSessionsV2,
  screenSessionsMethods,
} from '../contracts/index.js';
import {
  createScreenSessionManager,
  type ScreenSession,
  ScreenSessionError,
  type ScreenSessionManager,
} from './session.js';

/** One `attach` request as the provider receives it. */
export interface ScreenAttachInput {
  readonly projectId: string;
  readonly lease: RuntimeLease;
  readonly call?: Call;
}

export interface ScreenSessions {
  /** Deduplicated per Project while a call is in flight. */
  attach(input: ScreenAttachInput): Promise<ScreenAttach>;
  /** Forgets the tokens this generation published, then closes. */
  dispose(): Promise<void>;
}

export interface ScreenSessionsDeps {
  readonly log: () => Log;
  /**
   * The relay the sessions publish on: `screen.relay/v1`, whose provider the
   * resident `screen-relay` bundle owns. Taken through a function so a call
   * that never reaches a session creates no relay handle.
   */
  readonly relay: () => ScreenRelay;
  readonly manager?: () => ScreenSessionManager;
}

export const createScreenSessions = (
  deps: ScreenSessionsDeps,
): ScreenSessions => {
  let manager: ScreenSessionManager | undefined;
  const sessions = new Map<string, ScreenSession>();
  const inFlight = new Map<string, Promise<ScreenAttach>>();

  const relayOf = () => deps.relay();
  const managerOf = () =>
    (manager ??= (
      deps.manager ?? (() => createScreenSessionManager({ log: deps.log }))
    )());

  const attach = async (input: ScreenAttachInput): Promise<ScreenAttach> => {
    const { projectId, lease, call } = input;

    try {
      const outcome = await lease.withLease(
        (sandbox) => managerOf().ensure(sandbox),
        call,
      );

      if (outcome.status !== 'ready') {
        return outcome.status === 'pending'
          ? { status: 'pending' }
          : { status: 'unavailable', reason: 'sandbox' };
      }

      const session = outcome.value;
      const current = relayOf();
      const previous = sessions.get(projectId);

      if (previous !== undefined && previous.token !== session.token) {
        await current.forget({ token: previous.token });
      }

      await current.expose({
        token: session.token,
        host: session.host,
        port: session.port,
      });
      sessions.set(projectId, session);

      return {
        status: 'ready',
        path: `/screen/${session.token}/`,
        display: `:${session.display}`,
      };
    } catch (error) {
      if (error instanceof ScreenSessionError) {
        deps.log().warn('The screen session is unavailable', {
          projectId,
          reason: error.reason,
        });

        return { status: 'unavailable', reason: error.reason };
      }

      throw error;
    }
  };

  return {
    attach: (input) => {
      const pending = inFlight.get(input.projectId);

      if (pending !== undefined) {
        return pending;
      }

      const run = attach(input).finally(() => inFlight.delete(input.projectId));

      inFlight.set(input.projectId, run);

      return run;
    },
    dispose: async () => {
      if (sessions.size === 0) {
        return;
      }

      // A relay that is already gone (a kernel restart) has nothing to forget,
      // and a failure here must not fail deactivation.
      const relay = relayOf();

      await Promise.all(
        [...sessions.values()].map((session) =>
          relay.forget({ token: session.token }).catch(() => undefined),
        ),
      );
      sessions.clear();
    },
  };
};

/** The `screen.sessions/v2` definition over one sessions owner. */
export const screenSessionsService = (sessions: ScreenSessions) =>
  defineService(ScreenSessionsV2, {
    attach: defineMethod({
      expose: 'desktop',
      ...screenSessionsMethods.attach,
      execute: (projectId: string, call: Call, services) =>
        sessions.attach({
          projectId,
          lease: services.use(RuntimeLeaseV1, call.scope),
          call,
        }),
    }),
  });
