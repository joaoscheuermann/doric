import { cn } from 'desktop/ui/utils';

import {
  identityRing,
  identityTone,
  initials,
} from '../../utility/identity-mark.js';

/**
 * The frame the reader's initials are drawn in: a compact circle the name beside
 * it labels. The rim is the avatar's own tone, so it reads as the mark's edge and
 * not as a grey outline.
 */
const READER_AVATAR_CLASS =
  'flex size-5 shrink-0 items-center justify-center rounded-full border font-normal text-[0.6em] leading-none text-foreground';

type ReaderAvatarProps = {
  readonly className?: string;
  readonly name: string;
};

/**
 * The mark the reader carries: the initials of their name over a tone derived
 * from it, so the same name reads the same everywhere. It says nothing to a
 * screen reader, because the name beside it does.
 */
export function ReaderAvatar({ className, name }: ReaderAvatarProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(READER_AVATAR_CLASS, className)}
      style={{
        backgroundColor: identityTone(name),
        borderColor: identityRing(name),
      }}
    >
      {initials(name)}
    </span>
  );
}
