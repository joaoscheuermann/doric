// `screen.sessions/v2` served through the router (spec "Sandbox leases";
// phase 3, slice S49): the sessions of `provider.ts` over `runtime.lease/v1`
// operations (`routedScreenLease`) and `screen.relay/v1` (`trackedRelay`).

import type { MessageInitShape } from '@bufbuild/protobuf';
import type { ServiceImpl } from '@connectrpc/connect';
import { ContractError, type Log } from 'bundle/contracts';
import type { HostContext } from 'bundle/host';
import { LeaseService } from 'runtime/contracts/gen/doric/runtime/lease/v1/lease_pb.js';

import type {
  AttachResponseSchema,
  SessionsService,
} from '../../contracts/gen/doric/screen/sessions/v2/sessions_pb.js';
import type { ScreenAttach } from '../../contracts/index.js';
import {
  createScreenSessions,
  type ScreenLease,
  type ScreenSessions,
} from '../provider.js';
import {
  createScreenSessionManager,
  type ScreenSessionManager,
} from '../session.js';
import { routedScreenLease } from './lease.js';
import { trackedRelay } from './relay.js';

export interface ScreenSessionsServiceOptions {
  /**
   * The session manager, built once at `activate` with `context.log`;
   * default `createScreenSessionManager({ log })`. Tests pass one with a
   * stubbed `portOpen` and `sleep`, or a fake.
   */
  readonly manager?: (log: Log) => ScreenSessionManager;
}

export interface ScreenSessionsServiceHandle {
  /**
   * `screen.sessions/v2` (2.1.0). `Attach({ projectId })` runs
   * `createScreenSessions(…).attach` with `routedScreenLease` over
   * `runtime.lease/v1` and `trackedRelay`, and answers its result as the
   * `status` oneof:
   * - `ready { path: '/screen/<token>/', display: ':<n>' }` once the relay
   *   serves the token (a different previous token of the Project is
   *   forgotten first);
   * - `pending {}` when the lease answers `pending`;
   * - `unavailable { reason: 'sandbox' }` for `unavailable`, `expired` or
   *   `missing` (before or during the steps);
   * - `unavailable { reason: 'missing-xpra' | 'start-failed' }` for a
   *   `ScreenSessionError`, logged at `warn` `The screen session is
   *   unavailable` `{ projectId, reason }`.
   * Concurrent calls for one `projectId` share one run and one answer.
   * Fails with the `ContractError` of a lease failure without `leaseStatus`
   * (`INVALID_ARGUMENT` for a call without Project or Thread scope) or of a
   * relay failure, unchanged; `UNAVAILABLE` `unavailable` ("The screen
   * sessions are not ready.") before `activate`.
   */
  readonly implementation: ServiceImpl<typeof SessionsService>;
  /** Binds the clients and the manager; makes no call. */
  activate(context: HostContext): void;
  /**
   * Forgets every token this instance exposed (and untracks it); a failed
   * `Forget` is ignored. Never rejects.
   */
  deactivate(): Promise<void>;
}

/** Builds the handle; makes no I/O. */
export const createScreenSessionsService = (
  options: ScreenSessionsServiceOptions = {},
): ScreenSessionsServiceHandle => {
  let bound:
    | { readonly sessions: ScreenSessions; readonly lease: ScreenLease }
    | undefined;

  const statusOf = (
    answer: ScreenAttach,
  ): MessageInitShape<typeof AttachResponseSchema>['status'] => {
    switch (answer.status) {
      case 'ready':
        return {
          case: 'ready',
          value: { path: answer.path, display: answer.display },
        };
      case 'pending':
        return { case: 'pending', value: {} };
      case 'unavailable':
        return { case: 'unavailable', value: { reason: answer.reason } };
    }
  };

  return {
    implementation: {
      attach: async ({ projectId }) => {
        if (bound === undefined) {
          throw new ContractError(
            'unavailable',
            'The screen sessions are not ready.',
          );
        }

        const answer = await bound.sessions.attach({
          projectId,
          lease: bound.lease,
        });

        return { status: statusOf(answer) };
      },
    },
    activate: (context) => {
      const manager = (
        options.manager ??
        ((log: Log) => createScreenSessionManager({ log: () => log }))
      )(context.log);
      const relay = trackedRelay(context);

      bound = {
        sessions: createScreenSessions({
          log: () => context.log,
          relay: () => relay,
          manager: () => manager,
        }),
        lease: routedScreenLease(context.services.use(LeaseService)),
      };
    },
    deactivate: async () => {
      await bound?.sessions.dispose();
    },
  };
};
