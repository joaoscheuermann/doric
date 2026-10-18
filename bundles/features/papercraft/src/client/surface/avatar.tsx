// `avatar.tsx` — who wrote a comment, as the conversation draws them: the
// reader wears the jdenticon of their name (the mark chat's `ReaderAvatar`
// draws), and the agent the bot mark of its turns.

import { cn } from 'desktop/ui/utils';
import { toSvg } from 'jdenticon';
import { BotIcon } from 'lucide-react';

import { AGENT_AUTHOR } from '../domain/preview-state.js';

/** The identicon the reader carries: the same name always draws the same mark. */
export const identiconSvg = (name: string): string => toSvg(name, 24);

/** The name a comment's author reads as: the agent, or the reader. */
export const authorName = (author: string | undefined): string =>
  author === undefined || author === '' ? 'você' : author;

/** The author's mark: the bot for the agent, the identicon for a reader. */
export function Avatar({
  name,
  className,
}: {
  readonly name: string;
  readonly className?: string;
}) {
  if (name === AGENT_AUTHOR) {
    return (
      <span
        aria-hidden="true"
        className={cn(
          'flex size-4.5 shrink-0 items-center justify-center rounded-full bg-foreground text-background',
          className,
        )}
      >
        <BotIcon className="size-3/5" />
      </span>
    );
  }

  const src = `data:image/svg+xml,${encodeURIComponent(identiconSvg(name))}`;

  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex size-4.5 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border/60 bg-background [&>svg]:size-full',
        className,
      )}
    >
      <img src={src} alt="" className="size-full" />
    </span>
  );
}
