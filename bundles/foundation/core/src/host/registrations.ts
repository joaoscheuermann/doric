// The `registrationId`s a routed service answers for its registrations.

import { randomUUID } from 'node:crypto';

import type { Caller, Disposable } from 'bundle/contracts';
import type { BundleInstance, StampedCaller } from 'bundle/host';

/**
 * The `registrationId`s of one service's registrations: each `Register`,
 * `Sink` or `RegisterKind` keeps the `Disposable` that core's registry
 * answered. Ids are opaque, start with `prefix`, are unique among this
 * table's answers and are never answered again.
 */
export interface Registrations {
  /** Keeps `disposable` for `caller`'s instance and answers its new id. */
  add(caller: StampedCaller, disposable: Disposable): string;
  /**
   * Disposes the registration `id` once and forgets it, when `caller` is of
   * the defining bundle (any instance). An unknown or forgotten id, or one
   * another bundle registered, is a no-op (S37 decision 2).
   */
  remove(id: string, caller: Caller): void;
  /**
   * Disposes every registration of `instance` (same `bundleId`,
   * `generation`, `incarnation`). A throwing `dispose` does not stop the
   * others. Core's own disposables never throw.
   */
  dropInstance(instance: BundleInstance): void;
}

export const createRegistrations = (prefix: string): Registrations => {
  const entries = new Map<
    string,
    { readonly caller: StampedCaller; readonly disposable: Disposable }
  >();

  return {
    add: (caller, disposable) => {
      const id = `${prefix}${randomUUID()}`;

      entries.set(id, { caller, disposable });

      return id;
    },
    remove: (id, caller) => {
      const entry = entries.get(id);

      if (entry !== undefined && entry.caller.bundleId === caller.bundleId) {
        entries.delete(id);
        entry.disposable.dispose();
      }
    },
    dropInstance: (instance) => {
      for (const [id, { caller, disposable }] of entries) {
        if (
          caller.bundleId === instance.bundleId &&
          caller.generation === instance.generation &&
          caller.incarnation === instance.incarnation
        ) {
          entries.delete(id);

          try {
            disposable.dispose();
          } catch {
            // One failing dispose does not keep the others.
          }
        }
      }
    },
  };
};
