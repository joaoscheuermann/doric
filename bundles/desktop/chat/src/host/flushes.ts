// The flush registrations of `chat.composer/v1` (phase 3, S58, D4/D5): one
// serving flush per comment kind, `message` held locally.

import type { Client } from '@connectrpc/connect';
import { ContractError } from 'bundle/contracts';
import {
  type BundleInstance,
  contractErrorOf,
  RegistrationTable,
  type StampedCaller,
} from 'bundle/host';

import type { ComposerFlushHandlerService } from '../contracts/gen/doric/chat/composer/v1/composer_pb.js';
import type { ComposerFlush } from '../contracts/index.js';
import {
  commentWriteOf,
  flushContextMessageOf,
  itemMessageOf,
} from './codec.js';

export interface ComposerFlushesOptions {
  /** This process's instance: it holds the local kinds. */
  readonly self: BundleInstance;
  /** The kinds this part flushes in process: `{ message: wireFlush(messageFlush) }` in the host. */
  readonly local: ReadonlyMap<string, ComposerFlush>;
  /**
   * A client of `caller`'s `ComposerFlushHandlerService`: `services.use(ComposerFlushHandlerService, { target:
   * '<bundleId>/<generation>/<incarnation>' })`. Called at flush time; creating it makes no call.
   */
  readonly handlerOf: (
    caller: StampedCaller,
  ) => Client<typeof ComposerFlushHandlerService>;
}

/** The flush registrations of `chat.composer/v1`: at most one serving flush per comment kind. */
export interface ComposerFlushes {
  /**
   * `RegisterFlush{kind}` for `caller` (`stampedCallerOf`):
   * - a local kind, or a kind whose serving registration is another bundle's: `ContractError('registration_conflict',
   *   'The <kind> comment kind already has a flush.', { kind })`, nothing registered;
   * - the same instance and kind again: the same `registrationId`;
   * - another instance of the caller's bundle: a new id; the newest instance's registration serves.
   */
  register(
    caller: StampedCaller,
    kind: string,
  ): { readonly registrationId: string };
  /** `Unregister`: removes the registration when `caller`'s bundle made it; an unknown or other bundle's id is a no-op. */
  unregister(caller: StampedCaller, registrationId: string): void;
  /** `InstanceGone`: drops every registration of `instance`; the newest remaining one of each kind serves. Never throws. */
  dropInstance(instance: BundleInstance): void;
  /**
   * The flush `createComposerState`'s `flushOf` reads: the local flush of a local kind; else, for a registered kind, a
   * flush that calls the serving registrant's `Flush{item: itemMessageOf(item), context: flushContextMessageOf(ctx)}`
   * with the current call's deadline and signal, and answers `writes.map(commentWriteOf)` (`invalid_output` on a
   * write without target); a failed call rejects with `contractErrorOf(error)` (code, message, details kept). The
   * registration is looked up per item, at flush time. `undefined` for a kind without registration.
   */
  flushOf(kind: string): ComposerFlush | undefined;
}

/** Builds the registrations; no I/O; never throws. */
export const createComposerFlushes = (
  options: ComposerFlushesOptions,
): ComposerFlushes => {
  const table = new RegistrationTable<StampedCaller>({
    conflictCode: 'registration_conflict',
  });
  /** The bundle that made each registration still held, for `Unregister`. */
  const owners = new Map<string, string>();
  const self: StampedCaller = { ...options.self, version: '' };

  for (const kind of options.local.keys()) {
    table.register(self, kind, self);
  }

  const conflict = (kind: string): ContractError =>
    new ContractError(
      'registration_conflict',
      `The ${kind} comment kind already has a flush.`,
      { kind },
    );

  return {
    register: (caller, kind) => {
      const serving = table.get(kind);

      if (
        options.local.has(kind) ||
        (serving !== undefined && serving.bundleId !== caller.bundleId)
      ) {
        throw conflict(kind);
      }

      const { registrationId } = table.register(caller, kind, caller);
      owners.set(registrationId, caller.bundleId);

      return { registrationId };
    },
    unregister: (caller, registrationId) => {
      if (owners.get(registrationId) === caller.bundleId) {
        table.remove(registrationId);
        owners.delete(registrationId);
      }
    },
    dropInstance: (instance) => {
      table.dropInstance(instance);
    },
    flushOf: (kind) => {
      const local = options.local.get(kind);

      if (local !== undefined) {
        return local;
      }

      const registrant = table.get(kind);

      if (registrant === undefined) {
        return undefined;
      }

      return async (item, context) => {
        try {
          const { writes } = await options.handlerOf(registrant).flush({
            item: itemMessageOf(item),
            context: flushContextMessageOf(context),
          });

          return writes.map(commentWriteOf);
        } catch (error) {
          throw contractErrorOf(error);
        }
      };
    },
  };
};
