import { type ProjectColor, projectColorSwatch } from '@/domain/workspace';
import { cn } from '@/utility/utils';

type ProjectAvatarProps = {
  readonly className?: string;
  readonly color?: ProjectColor;
};

/**
 * The mark a Project carries in place of an icon: the color it was given, or a
 * hollow ring while none is set. It reads nothing — the color arrives through
 * props — and says nothing to a screen reader, because the name beside it does.
 */
export function ProjectAvatar({ className, color }: ProjectAvatarProps) {
  return (
    <span
      aria-hidden
      className={cn(
        'size-3.5 shrink-0 rounded-full',
        color === undefined
          ? 'ring-1 ring-sidebar-foreground/40 ring-inset'
          : projectColorSwatch[color],
        className,
      )}
    />
  );
}
