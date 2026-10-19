import { cn } from 'desktop/ui/utils';
import {
  BotMessageSquareIcon,
  GitBranchIcon,
  GithubIcon,
  MessageCircleIcon,
  MessageCirclePlusIcon,
} from 'lucide-react';

import type { ThreadIconKind } from '../../domain/sidebar.js';
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
 * the reader opened, and the bot that owns an agent Thread. Every Thread is a
 * conversation, so the bubble does not vary with the working directory. The
 * wrapper sets the size, so a surface that forces a size on its own icons (the
 * sidebar button, the tab strip) cannot make the mark heavier than the text
 * beside it.
 */
export function ThreadKindIcon({ kind }: { readonly kind: ThreadKind }) {
  const Icon = glyph[threadKindIcon[kind]];
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center [&>svg]:size-3.5"
    >
      <Icon />
    </span>
  );
}

/**
 * The repository a Thread's cwd sits in, drawn where the plus appears: a branch
 * for a local repository, the GitHub mark for one whose origin is on GitHub.
 * Every Thread carries it, whatever its kind, and it steps aside for the plus
 * on hover.
 */
export function RepoMark({
  className,
  repo,
}: {
  readonly className?: string;
  readonly repo: ThreadIconKind;
}) {
  if (repo === 'conversation') return null;
  const Icon = repo === 'github' ? GithubIcon : GitBranchIcon;
  return (
    <span
      aria-hidden
      title={repo === 'github' ? 'GitHub repository' : 'Git repository'}
      className={cn(
        'pointer-events-none flex items-center justify-center text-muted-foreground/70 [&>svg]:size-3',
        className,
      )}
    >
      <Icon />
    </span>
  );
}
