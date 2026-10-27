import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from 'cn';
import type { ComponentProps } from 'react';

/**
 * Where a comment's thread stands, as the pin's fill: the same vocabulary the
 * conversation and the canvas share (`open`, `await`, `done`, and `draft` for a
 * comment still in the composer stack).
 */
export type CommentPinState = 'open' | 'await' | 'done' | 'draft';

/**
 * How big the pin is. A pin that sits in a line of text (a reply row) is `sm`,
 * the one a canvas places on its content is `md`, and `lg` leads with the
 * number where nothing crowds it.
 */
export type CommentPinSize = 'sm' | 'md' | 'lg';

/**
 * The pin's shape with its state and size variants, as the design system writes
 * them (`cva`, like `Button` and `Badge`): the colour alone says where the
 * thread stands — a resolved thread green, an awaiting one orange, an open one
 * primary, a draft a dashed outline — and the size steps the teardrop and its
 * number together, so a pin reads the same at any size.
 */
const commentPinVariants = cva(
  'inline-flex shrink-0 cursor-pointer items-center justify-center rounded-[9999px_9999px_9999px_0] font-normal tabular-nums shadow-md transition-transform duration-120 origin-bottom-left hover:scale-110 focus-visible:scale-110 outline-none focus-visible:outline-2 focus-visible:outline-ring',
  {
    variants: {
      state: {
        open: 'bg-primary text-primary-foreground',
        await: 'bg-[var(--paper-orange)] text-[#1d1300]',
        done: 'bg-[var(--paper-green)] text-primary-foreground',
        draft:
          'border-[1.5px] border-dashed border-primary bg-popover text-primary',
      },
      size: {
        sm: 'size-5 text-[10px]',
        md: 'size-6 text-[11px]',
        lg: 'size-7 text-[12px]',
      },
    },
    defaultVariants: {
      state: 'open',
      size: 'md',
    },
  },
);

export interface CommentPinProps
  extends Omit<ComponentProps<'button'>, 'type'>,
    VariantProps<typeof commentPinVariants> {}

/**
 * The comment pin both surfaces draw — the conversation's reply row and the
 * canvas's layer — so the same thread reads the same way in both places. It is
 * presentation only: the caller wires what a press means (opening the thread's
 * popover, opening it on the canvas) and where the pin sits.
 */
export function CommentPin({
  state,
  size,
  className,
  children,
  ...props
}: CommentPinProps) {
  return (
    <button
      type="button"
      data-state={state}
      data-size={size ?? 'md'}
      className={cn(commentPinVariants({ state, size }), className)}
      {...props}
    >
      {children}
    </button>
  );
}

export { commentPinVariants };
