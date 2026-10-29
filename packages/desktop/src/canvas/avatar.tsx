// `avatar.tsx` — who wrote a comment, as the conversation draws them: the
// reader wears the jdenticon of their name (the mark chat's `ReaderAvatar`
// draws), and the agent the bot mark of its turns.

import { toSvg } from 'jdenticon';
import { BotIcon } from 'lucide-react';

import { cn } from '../lib/utils.js';
import { AGENT_AUTHOR } from './threads.js';

/** The identicon a reader carries: the same name always draws the same 24px mark. */
export const identiconSvg = (name: string): string => toSvg(name, 24);

/** The name a comment's author reads as: the author, or `você` when absent or empty. */
export const authorName = (author: string | undefined): string =>
  author === undefined || author === '' ? 'você' : author;

/** The author's mark: the bot for `AGENT_AUTHOR`, the identicon for a reader. */
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
