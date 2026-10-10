import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import type { ChatBlock, RenderBlock } from '../../contracts/index.js';
import type { DrawnBlock } from '../components/organisms/conversation/nodes/chat-block-node.js';
import type { PlacedBlock } from '../components/organisms/conversation/plugins/insert-thread-turn-nodes.js';
import { externalBlocks } from '../domain/external-blocks.js';
import type { ThreadEvent } from '../domain/workspace.js';
import { chatHooks } from '../services/chat-hooks.js';
import {
  builtInAliases,
  type ChatViewsRegistry,
  chatViewsRegistry,
} from '../services/views.js';

const noSubscription = (): (() => void) => () => undefined;
let registryVersion = 0;

/** Re-renders when a projector or renderer is registered or removed. */
const useRegistry = (): ChatViewsRegistry | undefined => {
  const registry = chatViewsRegistry();
  useSyncExternalStore(
    registry === undefined
      ? noSubscription
      : (listener) =>
          registry.subscribe(() => {
            registryVersion += 1;
            listener();
          }),
    () => registryVersion,
    () => registryVersion,
  );
  return registry;
};

const reportProjector = (error: unknown): void => {
  console.warn('Doric: a chat projector failed on an event:', error);
};

const noPlaced: readonly PlacedBlock[] = Object.freeze([]);

/**
 * The blocks other bundles' projectors make of one Thread's log (§7.7), run
 * over the same event list the built-in projection reads, and how each one is
 * drawn. `onBeforeRenderBlockHook` may add actions to a block; until it
 * answers, and when it fails, the block is drawn as projected.
 */
export const useExternalBlocks = (
  events: readonly ThreadEvent[],
): {
  readonly placed: readonly PlacedBlock[];
  readonly drawn: ReadonlyMap<string, DrawnBlock>;
} => {
  const registry = useRegistry();
  const projectors = registry?.projectors();
  const blocks = useMemo<readonly ChatBlock[]>(
    () =>
      projectors === undefined
        ? []
        : externalBlocks(events, projectors, builtInAliases, reportProjector),
    [events, projectors],
  );
  const [transformed, setTransformed] = useState<
    ReadonlyMap<ChatBlock, RenderBlock>
  >(() => new Map());

  useEffect(() => {
    // Only the blocks the log still makes keep their transformed version.
    setTransformed((previous) => {
      const kept = new Set(blocks);
      if ([...previous.keys()].every((block) => kept.has(block))) {
        return previous;
      }
      return new Map([...previous].filter(([block]) => kept.has(block)));
    });
    const hooks = chatHooks();
    if (hooks === undefined || blocks.length === 0) return;
    let live = true;
    for (const block of blocks) {
      const input: RenderBlock = { ...block, actions: [] };
      let pending: Promise<RenderBlock>;
      try {
        pending = hooks.onBeforeRenderBlockHook.execute(input);
      } catch {
        continue;
      }
      pending.then(
        (output) => {
          if (!live) return;
          setTransformed((previous) => {
            const next = new Map(previous);
            next.set(block, {
              ...input,
              data: output.data,
              actions: output.actions,
            });
            return next;
          });
        },
        () => undefined,
      );
    }
    return () => {
      live = false;
    };
  }, [blocks]);

  return useMemo(() => {
    if (blocks.length === 0) return { placed: noPlaced, drawn: new Map() };
    const drawn = new Map<string, DrawnBlock>();
    const placed: PlacedBlock[] = [];
    for (const block of blocks) {
      placed.push({ id: block.id, sequence: block.sequence });
      drawn.set(block.id, {
        block: transformed.get(block) ?? { ...block, actions: [] },
        tag: registry?.rendererFor(block.type) ?? 'chat-block',
      });
    }
    return { placed, drawn };
  }, [blocks, registry, transformed]);
};
