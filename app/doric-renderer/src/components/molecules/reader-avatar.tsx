import { identiconSvg } from '@/utility/identicon';
import { cn } from '@/utility/utils';

/**
 * The frame the reader's identicon is drawn in: a compact circle the name beside
 * it labels.
 */
const READER_AVATAR_CLASS =
  'flex size-4.5 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border/60 [&>svg]:size-full';

type ReaderAvatarProps = {
  readonly className?: string;
  readonly name: string;
};

/**
 * The mark the reader carries: a jdenticon of their name. It says nothing to a
 * screen reader, because the name beside it does.
 */
export function ReaderAvatar({ className, name }: ReaderAvatarProps) {
  // The identicon is an SVG string and nothing else, so it is carried as an
  // image the policy already allows (`img-src 'self' data:`) rather than as raw
  // HTML injected into the frame.
  const src = `data:image/svg+xml,${encodeURIComponent(identiconSvg(name))}`;
  return (
    <span aria-hidden="true" className={cn(READER_AVATAR_CLASS, className)}>
      <img src={src} alt="" className="size-full" />
    </span>
  );
}
