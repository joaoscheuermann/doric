/**
 * The turns a conversation draws (`chat.views/v1` 1.2.0): the projection's own
 * while no bundle draws a tool or an input, and otherwise the projection's
 * drafts grouped with each tool's drawing and stamped with each input's
 * element. Kept apart from `projector.ts` and `tool-drawing.ts` so neither
 * imports a value from the other.
 */

import type { ToolRendererSpec } from '../../contracts/index.js';
import { groupTurns, type Projection, type Turn } from './projector.js';
import { inputSourceKey, toolDrawing } from './tool-drawing.js';

/**
 * The turns a conversation draws: `projection.turns` itself while nothing is
 * registered; otherwise the drafts grouped with each tool's `toolDrawing`, and
 * every user turn whose `inputSourceKey` has an input renderer carrying `element`.
 */
export const drawnTurns = (
  projection: Projection,
  tools: ReadonlyMap<string, ToolRendererSpec>,
  inputs: ReadonlyMap<string, string>,
): readonly Turn[] => {
  if (tools.size === 0 && inputs.size === 0) return projection.turns;
  const grouped =
    tools.size === 0
      ? projection.turns
      : groupTurns(
          projection.drafts,
          projection.status,
          (name) => toolDrawing(name, tools).standalone,
        );
  if (inputs.size === 0) return grouped;
  return grouped.map((turn) => {
    if (turn.type !== 'user' || turn.input === undefined) return turn;
    const key = inputSourceKey(turn.input.source);
    const element = key === undefined ? undefined : inputs.get(key);
    return element === undefined ? turn : { ...turn, element };
  });
};
