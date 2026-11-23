// The provider's side of registrations (spec `docs/designs/grpc-processes.md`,
// section 4, "Keys across instances" (D4) and "`RegistrationTable`" (A66)):
// the table that applies D4's key rule, and the stamped caller it keys
// registrations by.

import type { HandlerContext } from '@connectrpc/connect';

import type { Caller } from '../../contracts/call.js';
import { ContractError } from '../../contracts/error.js';
import { callerIncarnationKey, callOf } from '../../contracts/metadata.js';

/**
 * The caller the router stamped on a call (section 3, step 1): the `Caller`
 * of the `Call` and the calling instance's incarnation, so it names one
 * instance, `<bundleId>/<generation>/<incarnation>`.
 */
export interface StampedCaller extends Caller {
  readonly incarnation: number;
}

/**
 * The stamped caller of the call `context` serves: the `Call`'s caller
 * (`callOf(context)`) and the incarnation of the `CallStart`'s caller. In a
 * call `bundle/testing`'s router serves, the incarnation is 1. Pure.
 *
 * Throws a `TypeError` when `context` is not the context of a call the host
 * SDK or `bundle/testing` serves, as `callOf` does.
 */
export const stampedCallerOf = (context: HandlerContext): StampedCaller => {
  const { caller } = callOf(context);
  const incarnation = context.values.get(callerIncarnationKey);

  if (incarnation === undefined) {
    throw new TypeError('The handler context holds no caller incarnation.');
  }

  return {
    bundleId: caller.bundleId,
    version: caller.version,
    generation: caller.generation,
    incarnation,
  };
};

/**
 * The code a {@link RegistrationTable} throws for a key another bundle
 * holds: `duplicate_tool` (`tools/v1`), `duplicate_skill` (`skills/v1`) or
 * `registration_conflict` (every other registration contract).
 */
export type RegistrationConflictCode =
  | 'duplicate_tool'
  | 'duplicate_skill'
  | 'registration_conflict';

export interface RegistrationTableOptions {
  /** The code of the `ContractError` a conflicting `register` throws. */
  readonly conflictCode: RegistrationConflictCode;
}

/** A registration that serves its key: the newest instance's. */
export interface RegistrationEntry<V> {
  readonly key: string;
  readonly registrationId: string;
  /** The registering instance, as `register` received it. */
  readonly caller: StampedCaller;
  readonly value: V;
}

/**
 * Registrations by key, with D4's key rule (A66). A provider keeps one table
 * per registration contract and calls `register` from the registration
 * method's handler with `stampedCallerOf(context)`, `remove` from its
 * removal method's, and `dropInstance` on `InstanceGone`
 * (`context.instances.onGone`).
 *
 * Two registrations are of the same instance when their callers have the
 * same `bundleId`, `generation` and `incarnation`. Of the registrations of a
 * key, the newest instance's (the highest generation, then the highest
 * incarnation) serves: `get` and `entries` answer it. A key is any string;
 * the provider chooses it (a tool's key is its `name`, U+0000, and its
 * `projectId` or nothing; the overlap of tools by Project is the provider's
 * own check, made before `register`).
 *
 * A `registrationId` is opaque, unique within the table and never answered
 * again for another registration. The table is synchronous, holds no timer
 * and never calls back.
 */
export class RegistrationTable<V> {
  /** The code of the `ContractError` a conflicting `register` throws. */
  readonly conflictCode: RegistrationConflictCode;

  /**
   * The registrations of each held key, in the order the keys were first
   * registered among those still held; a key without one is deleted.
   */
  private readonly byKey = new Map<string, RegistrationEntry<V>[]>();
  /** The key of each held registration. */
  private readonly keyOf = new Map<string, string>();
  private nextId = 1;

  constructor(options: RegistrationTableOptions) {
    this.conflictCode = options.conflictCode;
  }

  /**
   * Registers `value` under `key` for `caller`'s instance:
   *
   * - the same instance and key again: replaces the value and answers the
   *   same `registrationId`;
   * - another instance of the same bundle holds the key: adds a
   *   registration with a new id; both are kept, and the newest instance's
   *   serves, whichever registered first;
   * - the key's serving registration belongs to another bundle: throws a
   *   `ContractError` with {@link conflictCode}, and the table is unchanged.
   */
  register(
    caller: StampedCaller,
    key: string,
    value: V,
  ): { readonly registrationId: string } {
    const held = this.byKey.get(key) ?? [];
    const serving = newest(held);

    if (serving !== undefined && serving.caller.bundleId !== caller.bundleId) {
      throw new ContractError(
        this.conflictCode,
        `${key} is registered by ${serving.caller.bundleId}.`,
      );
    }

    const existing = held.find((entry) => sameInstance(entry.caller, caller));
    const registrationId = existing?.registrationId ?? `r${this.nextId++}`;
    const entry: RegistrationEntry<V> = { key, registrationId, caller, value };

    if (existing === undefined) {
      held.push(entry);
    } else {
      held[held.indexOf(existing)] = entry;
    }

    this.byKey.set(key, held);
    this.keyOf.set(registrationId, key);

    return { registrationId };
  }

  /**
   * Removes the registration `registrationId`; answers `true` when it held
   * one, `false` for an unknown or already removed id. When it served its
   * key, the newest remaining instance's registration of the key serves.
   */
  remove(registrationId: string): boolean {
    const key = this.keyOf.get(registrationId);

    if (key === undefined) {
      return false;
    }

    this.drop(key, (entry) => entry.registrationId === registrationId);

    return true;
  }

  /**
   * Removes every registration of `instance` (same `bundleId`, `generation`
   * and `incarnation`), for `InstanceGone`; the newest remaining registration
   * of each of its keys serves. An instance without registrations changes
   * nothing.
   */
  dropInstance(instance: {
    readonly bundleId: string;
    readonly generation: number;
    readonly incarnation: number;
  }): void {
    for (const key of [...this.byKey.keys()]) {
      this.drop(key, (entry) => sameInstance(entry.caller, instance));
    }
  }

  /** The value of the registration that serves `key`; `undefined` when none. */
  get(key: string): V | undefined {
    return newest(this.byKey.get(key) ?? [])?.value;
  }

  /**
   * The serving registration of every key, one entry per key, in the order
   * the keys were first registered among those still held. A new array on
   * each call.
   */
  entries(): readonly RegistrationEntry<V>[] {
    return [...this.byKey.values()].flatMap((held) => newest(held) ?? []);
  }

  /** Removes the registrations of `key` that `matches`; forgets an empty key. */
  private drop(
    key: string,
    matches: (entry: RegistrationEntry<V>) => boolean,
  ): void {
    const held = this.byKey.get(key) ?? [];
    const kept = held.filter((entry) => !matches(entry));

    for (const entry of held) {
      if (matches(entry)) {
        this.keyOf.delete(entry.registrationId);
      }
    }

    if (kept.length === 0) {
      this.byKey.delete(key);
    } else {
      this.byKey.set(key, kept);
    }
  }
}

interface InstanceOf {
  readonly bundleId: string;
  readonly generation: number;
  readonly incarnation: number;
}

const sameInstance = (a: InstanceOf, b: InstanceOf): boolean =>
  a.bundleId === b.bundleId &&
  a.generation === b.generation &&
  a.incarnation === b.incarnation;

/** The registration of the newest instance: highest generation, then incarnation. */
const newest = <V>(
  held: readonly RegistrationEntry<V>[],
): RegistrationEntry<V> | undefined =>
  held.reduce<RegistrationEntry<V> | undefined>(
    (best, entry) =>
      best === undefined ||
      entry.caller.generation > best.caller.generation ||
      (entry.caller.generation === best.caller.generation &&
        entry.caller.incarnation > best.caller.incarnation)
        ? entry
        : best,
    undefined,
  );
