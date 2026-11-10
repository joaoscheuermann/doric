import type { DoricTheme } from 'bundle/contracts';
import { cn } from 'desktop/ui/utils';
import { CheckIcon } from 'lucide-react';
import type { KeyboardEvent, Ref } from 'react';

import { ThemePreview } from './theme-preview.js';

/** The name and sentence each theme's tile shows (§4.1). */
export const themeLabels: Readonly<
  Record<DoricTheme, { readonly title: string; readonly description: string }>
> = {
  dark: {
    title: 'Dark (default)',
    description: 'Earthy dark surfaces with a cream accent',
  },
  light: { title: 'Light', description: 'Warm light surfaces' },
  system: { title: 'System', description: 'Follow the macOS appearance' },
};

/**
 * One theme choice (`65:13362`): the theme's preview in a frame ringed by
 * `--primary` when selected, above a choice card with the theme's name, its
 * sentence and a checkbox look. The tile is one radio of the Theme group
 * (G9); the checkbox only draws the selection. Every tile is at least 178
 * tall, as Figma draws the row, so the cards line up.
 */
export function ThemeOption({
  theme,
  selected,
  disabled,
  focusable,
  onSelect,
  onKeyDown,
  ref,
}: {
  readonly theme: DoricTheme;
  readonly selected: boolean;
  readonly disabled: boolean;
  /** Whether Tab reaches this tile (the group's one tab stop). */
  readonly focusable: boolean;
  readonly onSelect: () => void;
  readonly onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
  readonly ref?: Ref<HTMLButtonElement>;
}) {
  const { title, description } = themeLabels[theme];
  const id = `theme-${theme}`;

  return (
    // biome-ignore lint/a11y/useSemanticElements: a tile holds a preview and a card, which an `<input type="radio">` cannot (G9)
    <button
      ref={ref}
      type="button"
      role="radio"
      aria-checked={selected}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      data-theme={theme}
      // Not the `disabled` attribute: it would take the focus off a tile the
      // reader just chose with the keyboard while the app saves it.
      aria-disabled={disabled}
      tabIndex={focusable ? 0 : -1}
      onClick={disabled ? undefined : onSelect}
      onKeyDown={onKeyDown}
      className="group/theme flex min-h-[178px] min-w-0 flex-1 flex-col gap-2 text-left outline-none aria-disabled:cursor-default"
    >
      <div
        data-slot="theme-preview-frame"
        className={cn(
          'w-full overflow-hidden rounded-lg',
          selected ? 'border-2 border-primary' : 'border border-border',
        )}
      >
        <ThemePreview theme={theme} />
      </div>
      <div
        data-slot="theme-choice-card"
        className={cn(
          'flex w-full flex-1 items-start gap-2 rounded-lg border p-2.5 transition-colors group-focus-visible/theme:border-ring group-focus-visible/theme:ring-3 group-focus-visible/theme:ring-ring/50',
          selected
            ? 'border-primary/30 bg-primary/5 dark:border-primary/20 dark:bg-primary/10'
            : 'border-border group-hover/theme:bg-muted/50',
        )}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span
            id={`${id}-title`}
            data-slot="theme-title"
            className="text-sm leading-5 font-normal text-foreground"
          >
            {title}
          </span>
          <span
            id={`${id}-description`}
            data-slot="theme-description"
            className="text-sm leading-normal font-light text-muted-foreground"
          >
            {description}
          </span>
        </div>
        <span className="flex pt-px">
          <span
            aria-hidden
            data-slot="theme-check"
            className={cn(
              'flex size-4 shrink-0 items-center justify-center rounded-[4px] border',
              selected
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-input dark:bg-input/30',
            )}
          >
            {selected && <CheckIcon className="size-3.5" />}
          </span>
        </span>
      </div>
    </button>
  );
}
