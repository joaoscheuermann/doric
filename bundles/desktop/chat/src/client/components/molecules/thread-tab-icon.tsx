import {
  BotMessageSquareIcon,
  MessageCircleDashedIcon,
  MessageCircleIcon,
  MessageCirclePlusIcon,
} from 'lucide-react';

import { isAgentThread, type Thread } from '../../domain/workspace.js';

const iconOf = (thread: Thread | undefined) => {
  if (thread === undefined) return MessageCircleIcon;
  if (thread.name === '') return MessageCircleDashedIcon;
  if (thread.parentThreadId === undefined) return MessageCircleIcon;
  if (isAgentThread(thread)) return BotMessageSquareIcon;
  return MessageCirclePlusIcon;
};

/**
 * A Thread's mark on its tab (spec §10): the dashed bubble for an Untitled
 * Thread, the bubble for a main Thread, the bot for an agent Thread and the
 * bubble with a plus for any other sub-thread. A Thread the window does not
 * describe draws the bubble. Draws exactly one icon, always `aria-hidden`.
 */
export function ThreadTabIcon({
  thread,
}: {
  readonly thread: Thread | undefined;
}) {
  const Icon = iconOf(thread);
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center [&>svg]:size-3.5"
    >
      <Icon />
    </span>
  );
}
