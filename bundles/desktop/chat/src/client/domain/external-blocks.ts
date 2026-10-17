// Blocks of other bundles' events (§7.7, D9-16), beside the built-in
// projection of `projector.ts`. The built-in projection claims every event
// type that is not a versioned bundle event (`<owner>.<name>/vN`), plus the
// qualified aliases of the durable runtime types; those keep today's
// behaviour exactly, including the types it ignores. A versioned type a
// registered projector claims becomes that projector's blocks; a versioned
// type nobody claims becomes one generic block per event.

import type { ChatBlock, ProjectorSpec } from '../../contracts/index.js';
import {
  COMMENTS_ADDED_EVENT,
  COMMENTS_RESOLVED_EVENT,
} from '../../contracts/index.js';
import type { ThreadEvent } from './workspace.js';

/** `<owner>.<name>/vN`: an event type a bundle declared. */
const versionedEventType = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+\/v[1-9][0-9]*$/;

/** Versioned event types the built-in projection claims as its own. */
const builtInVersionedTypes: readonly string[] = [
  COMMENTS_ADDED_EVENT,
  COMMENTS_RESOLVED_EVENT,
];

/** The block type of an event no projector claims. */
export const GENERIC_BLOCK_TYPE = 'chat.generic';

/** The generic block's data: the event as it was persisted. */
export interface GenericBlockData {
  readonly eventType: string;
  readonly createdAt: string;
  readonly payload: unknown;
}

/**
 * Whether the built-in projection owns an event type. `aliases` are the
 * qualified types durable events are also read as (`runtime/contracts`
 * `legacyEventTypes` values, such as `runtime.prompt-finished/v1`). The
 * comment events are claimed too: the user turn wears a send's comments above
 * the reader's words, the agent's turn draws its replies, and the resolutions
 * are the state their markers show — so they never become the payload dump a
 * generic block is.
 */
export const builtInClaims = (
  type: string,
  aliases: readonly string[],
): boolean =>
  !versionedEventType.test(type) ||
  builtInVersionedTypes.includes(type) ||
  aliases.includes(type);

/**
 * Every external block of one event list, ordered by `sequence` (then the
 * order projectors produced them). Each projector runs from its initial state
 * over the whole list, so replay and rewind reuse it; a projector that throws
 * on an event keeps its previous state and adds nothing for that event.
 */
export const externalBlocks = (
  events: readonly ThreadEvent[],
  projectors: readonly ProjectorSpec[],
  aliases: readonly string[],
  onFailure: (error: unknown) => void = () => undefined,
): readonly ChatBlock[] => {
  const blocks: { readonly block: ChatBlock; readonly order: number }[] = [];
  const claimed = new Set<string>();
  let order = 0;

  for (const projector of projectors) {
    const types = new Set(projector.eventTypes);
    for (const type of types) claimed.add(type);
    let state: unknown;
    try {
      state = projector.initial();
    } catch (error) {
      onFailure(error);
      continue;
    }
    for (const event of events) {
      if (!types.has(event.type)) continue;
      try {
        const next = projector.reduce(state, event);
        state = next.state;
        for (const block of next.blocks) blocks.push({ block, order: order++ });
      } catch (error) {
        onFailure(error);
      }
    }
  }

  // The built-in claim is a property of the type, read once per type rather
  // than once per event: a long log repeats a few types thousands of times.
  const builtIn = new Map<string, boolean>();
  for (const event of events) {
    if (claimed.has(event.type)) continue;
    let claim = builtIn.get(event.type);
    if (claim === undefined) {
      claim = builtInClaims(event.type, aliases);
      builtIn.set(event.type, claim);
    }
    if (claim) continue;
    const data: GenericBlockData = {
      eventType: event.type,
      createdAt: event.createdAt,
      payload: event.event,
    };
    blocks.push({
      block: {
        id: `event:${event.sequence}`,
        type: GENERIC_BLOCK_TYPE,
        promptId: event.promptId,
        sequence: event.sequence,
        data,
      },
      order: order++,
    });
  }

  return blocks
    .sort(
      (left, right) =>
        left.block.sequence - right.block.sequence || left.order - right.order,
    )
    .map(({ block }) => block);
};

/** Whether a value is a plain object: what a block's JSON-shaped data is made of. */
const isPlainObject = (
  value: unknown,
): value is Readonly<Record<string, unknown>> => {
  if (typeof value !== 'object' || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/**
 * Whether two readings of a block's data say the same thing: plain objects
 * and arrays member by member, everything else by identity — a projector's
 * data is the JSON its events carry, and anything richer is its own.
 */
const sameData = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => sameData(item, right[index]))
    );
  }
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) => Object.hasOwn(right, key) && sameData(left[key], right[key]),
    )
  );
};

const sameBlock = (left: ChatBlock, right: ChatBlock): boolean =>
  left === right ||
  (left.id === right.id &&
    left.type === right.type &&
    left.promptId === right.promptId &&
    left.sequence === right.sequence &&
    sameData(left.data, right.data));

/**
 * `next` with every block that reads the same as the one `previous` held
 * under its id standing in as that held block, and `previous` itself when
 * the two lists read the same throughout. The projectors run from scratch
 * over the whole log on every batch, so every block they return is a new
 * object; a surface that keys its work on the block — the element drawn for
 * it, the hook answered for it — needs the block to keep its identity while
 * it says the same thing.
 */
export const reuseBlocks = (
  previous: readonly ChatBlock[],
  next: readonly ChatBlock[],
): readonly ChatBlock[] => {
  const held = new Map(previous.map((block) => [block.id, block]));
  let unchanged = previous.length === next.length;
  const reused = next.map((block, index) => {
    const before = held.get(block.id);
    const kept =
      before !== undefined && sameBlock(before, block) ? before : block;
    if (kept !== previous[index]) unchanged = false;
    return kept;
  });
  return unchanged ? previous : reused;
};
