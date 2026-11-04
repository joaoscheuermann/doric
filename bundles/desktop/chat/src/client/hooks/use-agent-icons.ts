import { type UseQueryResult, useQueries } from '@tanstack/react-query';
import { useMemo, useRef } from 'react';

import { readModelIcon } from '../api/model-icons.js';
import {
  type AgentIcons,
  type AgentMarkIcon,
  answeredKey,
} from '../components/organisms/conversation/nodes/turn-avatar.js';
import type { AnsweredBy } from '../domain/conversation-authors.js';
import type { Turn } from '../domain/projector.js';
import { queryKeys } from '../queries/keys.js';

/** Each distinct answering model the agent turns name, in first-seen order. */
const answeringModels = (turns: readonly Turn[]): readonly AnsweredBy[] => {
  const seen = new Map<string, AnsweredBy>();
  for (const turn of turns) {
    if (turn.type !== 'agent' || turn.answeredBy === undefined) continue;
    const key = answeredKey(turn.answeredBy);
    if (!seen.has(key)) seen.set(key, turn.answeredBy);
  }
  return [...seen.values()];
};

/** The icon a read's state draws: its SVG, the bot glyph, or nothing yet. */
const iconOf = (
  result: UseQueryResult<string | null> | undefined,
): AgentMarkIcon => {
  if (result?.status !== 'success') return { kind: 'pending' };
  return result.data === null
    ? { kind: 'fallback' }
    : { kind: 'icon', svg: result.data };
};

const sameIcon = (left: AgentMarkIcon, right: AgentMarkIcon | undefined) =>
  left.kind === right?.kind &&
  (left.kind !== 'icon' || (right.kind === 'icon' && left.svg === right.svg));

const sameIcons = (left: AgentIcons, right: AgentIcons): boolean =>
  left.size === right.size &&
  [...left].every(([key, icon]) => sameIcon(icon, right.get(key)));

/**
 * The icon of each answering model the agent turns name, keyed by
 * `answeredKey`: one query per distinct pair (`queryKeys.modelIcon`, read by
 * `readModelIcon`), kept for the window's life (`staleTime` and `gcTime`
 * `Infinity`) and never retried. A string is `icon`, `null` is `fallback`, and
 * a pending or failed read is `pending`. A turn without `answeredBy` adds no
 * entry. The map keeps its identity across renders until some entry's state
 * changes. Must render under the chat's `QueryClientProvider`.
 */
export const useAgentIcons = (turns: readonly Turn[]): AgentIcons => {
  const models = useMemo(() => answeringModels(turns), [turns]);
  const results = useQueries({
    queries: models.map(({ providerId, model }) => ({
      queryKey: queryKeys.modelIcon(providerId, model),
      queryFn: () => readModelIcon(providerId, model),
      staleTime: Number.POSITIVE_INFINITY,
      gcTime: Number.POSITIVE_INFINITY,
      retry: false,
    })),
  });
  const icons: AgentIcons = new Map(
    models.map((answered, index) => [
      answeredKey(answered),
      iconOf(results[index]),
    ]),
  );
  const kept = useRef(icons);
  if (!sameIcons(kept.current, icons)) kept.current = icons;
  return kept.current;
};
