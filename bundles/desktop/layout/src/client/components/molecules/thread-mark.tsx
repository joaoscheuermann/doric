import {
  BotMessageSquareIcon,
  MessageCircleDashedIcon,
  MessageCircleIcon,
  MessageCirclePlusIcon,
} from 'lucide-react';

import {
  type ThreadKind,
  type ThreadKindIconName,
  threadKindIcon,
} from '../../domain/thread-kind.js';

/** The glyph that paints each icon name. */
const glyph: Record<ThreadKindIconName, typeof MessageCircleIcon> = {
  'message-circle': MessageCircleIcon,
  'message-circle-plus': MessageCirclePlusIcon,
  'bot-message-square': BotMessageSquareIcon,
};

/**
 * A Thread's mark, the same on its sidebar row, its breadcrumb and its tab: a
 * bubble for the reader's own Thread, a bubble with a plus for the sub-thread
 * the reader opened, and the bot that owns an agent Thread. An Untitled Thread
 * (`untitled`) wears the dashed bubble instead, whatever its kind. Every Thread
 * is a conversation, so the bubble does not vary with the working directory.
 * The wrapper sets the size, so a surface that forces a size on its own icons
 * (the sidebar button, the tab strip) cannot make the mark heavier than the
 * text beside it.
 *
 * Draws exactly one icon, always `aria-hidden`.
 */
export function ThreadKindIcon({
  kind,
  untitled = false,
}: {
  readonly kind: ThreadKind;
  /** Draws the Untitled icon (`message-circle-dashed`) instead of the kind's. Default false. */
  readonly untitled?: boolean;
}) {
  const Icon = untitled ? MessageCircleDashedIcon : glyph[threadKindIcon[kind]];
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center [&>svg]:size-3.5"
    >
      <Icon />
    </span>
  );
}
