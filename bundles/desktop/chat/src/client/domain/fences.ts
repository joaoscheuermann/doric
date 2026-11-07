// Fences of a registered tag in the agent's answers (openui.md D1, D2): their
// keys, bodies and states, read from the same markdown blocks the transcript
// draws. The key is `${promptId}/${turnSequence}/${index}`, `index` counting
// the earlier fences of the same tag in the turn.

import type { ChatFence } from '../../contracts/index.js';
import { lineSource, type MarkdownBlock, markdownBlocks } from './markdown.js';
import { lastTurnIndex, type Turn } from './projector.js';

/** A code block's fence: its opener's tag and info, its body, whether it closed. */
export interface BlockFence {
  readonly tag: string;
  readonly info: string;
  readonly body: readonly string[];
  readonly closed: boolean;
}

const OPENER = /^\s*(`{3,}|~{3,})(.*)$/;
const CLOSER = /^\s*(`{3,}|~{3,})\s*$/;

/** Reads a `code` block's lines, opener and closer included (`markdown.ts`). */
export const blockFence = (block: MarkdownBlock): BlockFence | undefined => {
  if (block.kind !== 'code') return undefined;
  const lines = block.lines.map(lineSource);
  const opener = OPENER.exec(lines[0] ?? '');
  if (opener === null) return undefined;
  const marker = opener[1] ?? '```';
  const info = (opener[2] ?? '').trim();
  const closer = CLOSER.exec(lines.at(-1) ?? '')?.[1];
  const closed =
    lines.length > 1 &&
    closer !== undefined &&
    closer[0] === marker[0] &&
    closer.length >= marker.length;
  return {
    tag: info.split(/\s+/)[0] ?? '',
    info,
    body: lines.slice(1, closed ? -1 : undefined),
    closed,
  };
};

/**
 * The fence each block of a turn is, for the registered `tags`: block index
 * to its tag and its index among the turn's fences of that tag.
 */
export const fenceIndexes = (
  blocks: readonly MarkdownBlock[],
  tags: ReadonlySet<string>,
): ReadonlyMap<number, { readonly tag: string; readonly index: number }> => {
  const counts = new Map<string, number>();
  const indexes = new Map<number, { tag: string; index: number }>();
  blocks.forEach((block, at) => {
    const fence = blockFence(block);
    if (fence === undefined || !tags.has(fence.tag)) return;
    const index = counts.get(fence.tag) ?? 0;
    counts.set(fence.tag, index + 1);
    indexes.set(at, { tag: fence.tag, index });
  });
  return indexes;
};

/** `<promptId>/<turnSequence>` from an agent node's `agent:<promptId>:<sequence>` key. */
export const keyPrefixOf = (turnKey: string): string => {
  const rest = turnKey.slice(turnKey.indexOf(':') + 1);
  const at = rest.lastIndexOf(':');
  return `${rest.slice(0, at)}/${rest.slice(at + 1)}`;
};

/** The settled statuses (D2): a prompt with none is still writing. */
const settled = new Set(['completed', 'failed', 'cancelled']);

/**
 * The fences of registered `tags` in a Thread's turns, in transcript order.
 * The last turn that is not a queue receipt streams while its prompt has no
 * settled status (D2).
 */
export const threadFences = (
  turns: readonly Turn[],
  tags: ReadonlySet<string>,
  thread: { readonly projectId: string; readonly threadId: string },
): readonly ChatFence[] => {
  if (tags.size === 0) return [];
  const live = turns[lastTurnIndex(turns)];
  return turns.flatMap((turn) => {
    if (turn.type !== 'agent') return [];
    const blocks = markdownBlocks(turn.text.trim());
    const indexes = fenceIndexes(blocks, tags);
    const sequence = turn.events[0]?.sequence ?? 0;
    const writing = turn === live && !settled.has(turn.status);
    return blocks.flatMap((block, at): ChatFence[] => {
      const placed = indexes.get(at);
      const fence = blockFence(block);
      if (placed === undefined || fence === undefined) return [];
      return [
        {
          key: `${turn.promptId}/${sequence}/${placed.index}`,
          projectId: thread.projectId,
          threadId: thread.threadId,
          promptId: turn.promptId,
          turnSequence: sequence,
          index: placed.index,
          info: fence.info,
          body: fence.body.join('\n'),
          state: fence.closed
            ? 'closed'
            : writing
              ? 'streaming'
              : 'unterminated',
        },
      ];
    });
  });
};
