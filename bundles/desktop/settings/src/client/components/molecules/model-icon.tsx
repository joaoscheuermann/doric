import { svgMask } from 'desktop/ui/svg-mask';
import { cn } from 'desktop/ui/utils';

/**
 * A model's or a provider's 16px icon, drawn as a mask in the text colour and
 * hidden from assistive technology: `<span aria-hidden="true"
 * data-slot="model-icon">`. The SVG reaches only the mask's URL, never the
 * document. Without an SVG it is an empty slot of the same size, so labels
 * stay aligned. `inlineStart` marks it `data-icon="inline-start"`, so a
 * `Button` pads for it as for a leading icon.
 */
export function ModelIcon({
  svg,
  inlineStart = false,
  className,
}: {
  readonly svg?: string;
  readonly inlineStart?: boolean;
  readonly className?: string;
}) {
  const mask =
    svg === undefined
      ? undefined
      : `${svgMask(svg)} center / contain no-repeat`;

  return (
    <span
      aria-hidden="true"
      data-slot="model-icon"
      data-icon={inlineStart ? 'inline-start' : undefined}
      className={cn(
        'size-4 shrink-0',
        svg !== undefined && 'bg-current',
        className,
      )}
      style={mask === undefined ? undefined : { mask, WebkitMask: mask }}
    />
  );
}
