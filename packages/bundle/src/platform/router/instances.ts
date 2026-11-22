// The instance table (spec `docs/designs/grpc-processes.md`, section 2, "The
// token", and section 7, "Instance states"): every instance the supervisor
// spawned, its state, and the token that identifies it on the router
// listener.

import { createHash, randomBytes } from 'node:crypto';

/**
 * The states of section 7. They move from `spawned` to `stopped` in this
 * order; an activation failure goes from `connected` to `stopping`; any state
 * before `stopped` can end in `lost` or `invalid`.
 */
export type InstanceState =
  | 'spawned'
  | 'connected'
  | 'active'
  | 'draining'
  | 'stopping'
  | 'stopped'
  | 'lost'
  | 'invalid';

/** An instance and its state, as the router and the supervisor see it. */
export interface InstanceRecord {
  readonly bundleId: string;
  /** The bundle's version, stamped as the caller's `version`. */
  readonly version: string;
  readonly generation: number;
  readonly incarnation: number;
  readonly state: InstanceState;
}

/**
 * An instance's key, `<bundleId>/<generation>/<incarnation>`, the form of the
 * `doric-target` header (section 3).
 */
export type InstanceKey = `${string}/${number}/${number}`;

/**
 * The key of an instance. Accepts any value with the three fields, so a
 * record, a generated `doric.platform.v1.Instance` or a `Caller` all work.
 * Pure; never throws.
 */
export const instanceKey = (instance: {
  readonly bundleId: string;
  readonly generation: number;
  readonly incarnation: number;
}): InstanceKey =>
  `${instance.bundleId}/${instance.generation}/${instance.incarnation}`;

/** The `doric.platform.v1.Instance` of a record: its three key fields. */
export const instanceOf = (record: InstanceRecord) => ({
  bundleId: record.bundleId,
  generation: record.generation,
  incarnation: record.incarnation,
});

/** The states that revoke a token. */
export const revokedStates: ReadonlySet<InstanceState> = new Set([
  'stopped',
  'lost',
  'invalid',
]);

const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('base64url');

/**
 * The instances of one host and their tokens. The table holds a token only
 * as its SHA-256, so the plain token exists only in the answer of `issue`.
 *
 * A token whose instance is `stopped`, `lost` or `invalid` is revoked: the
 * table still answers its record, so the router can tell `instance_revoked`
 * from `invalid_instance_token`.
 */
export class InstanceTable {
  private readonly records = new Map<InstanceKey, InstanceRecord>();
  private readonly keysByTokenHash = new Map<string, InstanceKey>();
  private readonly listeners = new Set<(record: InstanceRecord) => void>();

  /**
   * Adds an instance in the state `spawned` and draws its token: 32 random
   * bytes, base64url without padding (43 characters), different on every
   * call. The supervisor passes it to the process as `DORIC_INSTANCE_TOKEN`.
   *
   * Throws a `TypeError` when the table already holds the instance's key: a
   * restart is a new incarnation, so a key is issued once.
   */
  issue(instance: Omit<InstanceRecord, 'state'>): { readonly token: string } {
    const key = instanceKey(instance);

    if (this.records.has(key)) {
      throw new TypeError(`The instance ${key} already has a token.`);
    }

    const token = randomBytes(32).toString('base64url');

    this.records.set(key, {
      bundleId: instance.bundleId,
      version: instance.version,
      generation: instance.generation,
      incarnation: instance.incarnation,
      state: 'spawned',
    });
    this.keysByTokenHash.set(hashToken(token), key);

    return { token };
  }

  /**
   * The record of the instance a token was issued to, whatever its state;
   * `undefined` for a token never issued. The answer is a snapshot: a later
   * `setState` does not change it.
   */
  byToken(token: string): InstanceRecord | undefined {
    const key = this.keysByTokenHash.get(hashToken(token));

    return key === undefined ? undefined : this.records.get(key);
  }

  /** The record of an instance; `undefined` for a key not in the table. */
  get(key: InstanceKey): InstanceRecord | undefined {
    return this.records.get(key);
  }

  /**
   * Sets an instance's state. Entering `stopped`, `lost` or `invalid` revokes
   * its token; there is no other way to revoke one, and a revoked token keeps
   * answering its record through `byToken`. A key not in the table is
   * ignored. The table does not check the order of section 7, except that a
   * revoked instance stays revoked: setting a state on a `stopped`, `lost` or
   * `invalid` instance is ignored.
   */
  setState(key: InstanceKey, state: InstanceState): void {
    const record = this.records.get(key);

    if (record === undefined || revokedStates.has(record.state)) {
      return;
    }

    const changed = { ...record, state };

    this.records.set(key, changed);

    for (const listener of [...this.listeners]) {
      try {
        listener(changed);
      } catch {
        // A failing listener stops neither the others nor the change.
      }
    }
  }

  /**
   * The instance of `bundleId` that new calls to the bundle go to: the one in
   * the state `active` with the highest generation, then the highest
   * incarnation; `undefined` when none is (during a start, a restart or
   * after the bundle stopped). A `draining` one is never answered. During a
   * publish the new generation is answered from the moment it is `active`,
   * before the supervisor sets the previous one `draining` (section 6,
   * "Publish", step 3).
   */
  activeOf(bundleId: string): InstanceRecord | undefined {
    let newest: InstanceRecord | undefined;

    for (const record of this.records.values()) {
      if (
        record.bundleId === bundleId &&
        record.state === 'active' &&
        (newest === undefined ||
          record.generation > newest.generation ||
          (record.generation === newest.generation &&
            record.incarnation > newest.incarnation))
      ) {
        newest = record;
      }
    }

    return newest;
  }

  /**
   * Calls `listener` with the new record after every `setState` the table
   * applies, in order, synchronously before `setState` returns; never for
   * an ignored one. Answers the function that removes the listener. A
   * listener that throws stops neither the others nor the change.
   */
  subscribe(listener: (record: InstanceRecord) => void): () => void {
    const entry = (record: InstanceRecord): void => listener(record);

    this.listeners.add(entry);

    return () => {
      this.listeners.delete(entry);
    };
  }
}
