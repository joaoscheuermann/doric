import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import type { ChatBlock, RenderBlock } from '../../contracts/index.js';
import type { DrawnBlock } from '../components/organisms/conversation/nodes/chat-block-node.js';
import type { PlacedBlock } from '../components/organisms/conversation/plugins/insert-thread-turn-nodes.js';
import { externalBlocks, reuseBlocks } from '../domain/external-blocks.js';
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

const noBlocks: readonly ChatBlock[] = Object.freeze([]);
const noPlaced: readonly PlacedBlock[] = Object.freeze([]);

/**
 * A block as projected, before any hook answers for it: what the hook is
 * asked with and what is drawn until it answers. One per block, so a block
 * drawn as projected keeps the same drawing across renders.
 */
const projected = new WeakMap<ChatBlock, RenderBlock>();
const asProjected = (block: ChatBlock): RenderBlock => {
  let input = projected.get(block);
  if (input === undefined) {
    input = { ...block, actions: [] };
    projected.set(block, input);
  }
  return input;
};

/**
 * The blocks other bundles' projectors make of one Thread's log (§7.7), run
 * over the same event list the built-in projection reads, and how each one is
 * drawn. `onBeforeRenderBlockHook` may add actions to a block; until it
 * answers, and when it fails, the block is drawn as projected.
 *
 * The projectors run over the whole log on every batch, so a block keeps its
 * identity across batches while it reads the same (`reuseBlocks`): the hook
 * is asked once per block, not once per flush, and a flush of deltas that
 * changes no block leaves `placed` and `drawn` as they were, so neither the
 * sync that seats the blocks nor the elements that draw them are run again.
 */
export const useExternalBlocks = (
  events: readonly ThreadEvent[],
): {
  readonly placed: readonly PlacedBlock[];
  readonly drawn: ReadonlyMap<string, DrawnBlock>;
} => {
  const registry = useRegistry();
  const projectors = registry?.projectors();
  const held = useRef(noBlocks);
  const blocks = useMemo<readonly ChatBlock[]>(() => {
    const fresh =
      projectors === undefined
        ? noBlocks
        : externalBlocks(events, projectors, builtInAliases, reportProjector);
    held.current = reuseBlocks(held.current, fresh);
    return held.current;
  }, [events, projectors]);
  const [transformed, setTransformed] = useState<
    ReadonlyMap<ChatBlock, RenderBlock>
  >(() => new Map());
  // The blocks already asked for, and the ones the log still makes: a block
  // is asked once, and its answer lands only while the log still makes it.
  const asked = useRef(new WeakSet<ChatBlock>());
  const wanted = useRef<ReadonlySet<ChatBlock>>(new Set());

  useEffect(() => {
    const kept = new Set(blocks);
    wanted.current = kept;
    // Only the blocks the log still makes keep their transformed version.
    setTransformed((previous) =>
      [...previous.keys()].every((block) => kept.has(block))
        ? previous
        : new Map([...previous].filter(([block]) => kept.has(block))),
    );
    const hooks = chatHooks();
    if (hooks === undefined) return;
    for (const block of blocks) {
      if (asked.current.has(block)) continue;
      asked.current.add(block);
      const input = asProjected(block);
      let pending: Promise<RenderBlock>;
      try {
        pending = hooks.onBeforeRenderBlockHook.execute(input);
      } catch {
        continue;
      }
      pending.then(
        (output) => {
          if (!wanted.current.has(block)) return;
          setTransformed((previous) =>
            new Map(previous).set(block, {
              ...input,
              data: output.data,
              actions: output.actions,
            }),
          );
        },
        () => undefined,
      );
    }
  }, [blocks]);

  // A surface that unmounted wants nothing: a late answer lands nowhere.
  useEffect(
    () => () => {
      wanted.current = new Set();
    },
    [],
  );

  return useMemo(() => {
    if (blocks.length === 0) return { placed: noPlaced, drawn: new Map() };
    const drawn = new Map<string, DrawnBlock>();
    const placed: PlacedBlock[] = [];
    for (const block of blocks) {
      placed.push({ id: block.id, sequence: block.sequence });
      drawn.set(block.id, {
        block: transformed.get(block) ?? asProjected(block),
        tag: registry?.rendererFor(block.type) ?? 'chat-block',
      });
    }
    return { placed, drawn };
  }, [blocks, registry, transformed]);
};
