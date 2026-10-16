// Blocks of other bundles' events (§7.7, D9-16), beside the built-in
// projection of `projector.ts`. The built-in projection claims every event
// type that is not a versioned bundle event (`<owner>.<name>/vN`), plus the
// qualified aliases of the durable runtime types; those keep today's
// behaviour exactly, including the types it ignores. A versioned type a
// registered projector claims becomes that projector's blocks; a versioned
// type nobody claims becomes one generic block per event.

import type { ChatBlock, ProjectorSpec } from '../../contracts/index.js';
import { COMMENTS_ADDED_EVENT } from '../../contracts/index.js';
import type { ThreadEvent } from './workspace.js';

/** `<owner>.<name>/vN`: an event type a bundle declared. */
const versionedEventType = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+\/v[1-9][0-9]*$/;

/** Versioned event types the built-in projection claims as its own. */
const builtInVersionedTypes: readonly string[] = [COMMENTS_ADDED_EVENT];

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
 * comments of a send are claimed too: the user turn wears them above the
 * reader's words, so they never become the payload dump a generic block is.
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

  for (const event of events) {
    if (builtInClaims(event.type, aliases) || claimed.has(event.type)) continue;
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
